import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { usuarioDe } from './autenticacion.js';
import { ErrorHttp } from './errores.js';

/**
 * Idempotency-Key (PLAN 3.5). Dos capas:
 *
 * 1. **Cerrojo en Redis** (`SET NX`) mientras el pedido está en vuelo: un duplicado simultáneo
 *    recibe 409 enseguida, sin llegar al caso de uso. Es la deduplicación.
 * 2. **Registro en Postgres, en la misma transacción que el efecto**, con la huella del pedido y la
 *    respuesta. Un reintento recibe la respuesta guardada; la misma clave con otro pedido, 422.
 *    Como el registro y el efecto confirman juntos, nunca hay efecto sin registro ni registro sin
 *    efecto. Y si el cerrojo vence con el pedido todavía en curso, la clave primaria del registro
 *    impide el segundo efecto: Redis acelera, la garantía la da Postgres.
 *
 * Solo se guarda lo que salió bien: un error no tuvo efecto, así que el reintento se vuelve a procesar.
 */

export const ENCABEZADO_IDEMPOTENCIA = 'Idempotency-Key';
export const ENCABEZADO_REPETIDA = 'Idempotent-Replayed';

/** Lista blanca: un UUID entra, y no hay espacios, comas ni `:` que se mezclen con la clave de Redis. */
export const ClaveIdempotencia = z
  .string({ error: `falta el encabezado ${ENCABEZADO_IDEMPOTENCIA}` })
  .regex(/^[A-Za-z0-9_-]{16,128}$/, 'tiene que tener entre 16 y 128 letras, números, - o _ (por ejemplo, un UUID)');

export interface RegistroIdempotencia {
  /** De quién es la clave: el mismo valor en dos usuarios son dos claves distintas. */
  alcance: string;
  clave: string;
  /** sha256 del método, la ruta y el cuerpo validado. */
  huella: string;
  estado: number;
  cuerpo: unknown;
}

/** Dónde quedan los registros. Cada servicio los guarda en su propia base. */
export interface AlmacenIdempotencia {
  buscar(alcance: string, clave: string): Promise<RegistroIdempotencia | null>;
  /**
   * Respaldo para las rutas cuyo efecto no pasa por una transacción del servicio: se guarda
   * después de responder. Si ya existía, no lo pisa.
   */
  guardar(registro: RegistroIdempotencia): Promise<void>;
}

/** El cerrojo de los pedidos en vuelo. `tomar` devuelve un token para soltarlo, o null si ya estaba tomado. */
export interface CerrojoEnVuelo {
  tomar(nombre: string, ttlMs: number): Promise<string | null>;
  soltar(nombre: string, token: string): Promise<void>;
}

interface PedidoIdempotente {
  alcance: string;
  clave: string;
  huella: string;
  estado: number;
  registrado: boolean;
}

const contexto = new AsyncLocalStorage<PedidoIdempotente>();

export type RegistroPendiente = Omit<RegistroIdempotencia, 'cuerpo'>;

/**
 * Para el adaptador de base del servicio: si el pedido trae Idempotency-Key y todavía no se
 * registró, devuelve lo que hay que insertar en la transacción del efecto (el cuerpo es el resultado
 * de esa transacción). Después del COMMIT se llama a `idempotenciaRegistrada`.
 */
export function idempotenciaPendiente(): RegistroPendiente | null {
  const pedido = contexto.getStore();
  if (!pedido || pedido.registrado) return null;
  const { alcance, clave, huella, estado } = pedido;
  return { alcance, clave, huella, estado };
}

export function idempotenciaRegistrada(): void {
  const pedido = contexto.getStore();
  if (pedido) pedido.registrado = true;
}

/** La transacción encontró la clave ya registrada: otro pedido con la misma clave confirmó antes. */
export class ClaveIdempotenciaEnCurso extends ErrorHttp {
  constructor() {
    super(409, 'CLAVE_IDEMPOTENCIA_EN_CURSO', 'Hay otro pedido con la misma Idempotency-Key en curso; reintentá en un momento');
  }
}

/** Las claves de un JSON en orden, para que `{a, b}` y `{b, a}` den la misma huella. */
function jsonCanonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(',')}]`;
  if (valor && typeof valor === 'object') {
    const pares = Object.keys(valor)
      .sort()
      .filter((k) => (valor as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${jsonCanonico((valor as Record<string, unknown>)[k])}`);
    return `{${pares.join(',')}}`;
  }
  return JSON.stringify(valor) ?? 'null';
}

/** Mismo método, misma ruta (con sus ids) y mismo cuerpo ya validado. La query no cuenta: estas rutas no la usan. */
function huellaDe(req: Request): string {
  const ruta = req.originalUrl.split('?')[0];
  return createHash('sha256').update(`${req.method} ${ruta}\n${jsonCanonico(req.body ?? {})}`).digest('hex');
}

export interface OpcionesIdempotencia {
  almacen: AlmacenIdempotencia;
  cerrojo: CerrojoEnVuelo;
  /** Tiene que superar lo que puede tardar un pedido: si vence antes, el duplicado lo frena Postgres. */
  ttlEnVueloMs?: number;
  /** Por defecto, el usuario del token: va después de `autenticar`. */
  alcance?: (req: Request) => string;
}

/**
 * Devuelve un armador de middlewares: `idempotente(201)` para una ruta que crea, `idempotente()` para
 * el resto. Va después de autenticar, del rol y de `validar`: un pedido rechazado no ocupa la clave.
 * Una ruta puede usar otro `alcance` (por ejemplo, usuario y flota): una clave guardada en un alcance
 * nunca se repite en otro.
 */
export function crearIdempotencia({
  almacen,
  cerrojo,
  ttlEnVueloMs = 30_000,
  alcance = (req) => usuarioDe(req).id,
}: OpcionesIdempotencia) {
  return (estado = 200, opciones: { alcance?: (req: Request) => string } = {}): RequestHandler =>
    async (req, res, next) => {
      const leida = ClaveIdempotencia.safeParse(req.header(ENCABEZADO_IDEMPOTENCIA));
      if (!leida.success) {
        throw new ErrorHttp(400, 'CLAVE_IDEMPOTENCIA_INVALIDA', `${ENCABEZADO_IDEMPOTENCIA}: ${leida.error.issues[0]?.message}`);
      }
      const pedido: PedidoIdempotente = {
        alcance: (opciones.alcance ?? alcance)(req),
        clave: leida.data,
        huella: huellaDe(req),
        estado,
        registrado: false,
      };

      const responderGuardado = (guardado: RegistroIdempotencia) => {
        if (guardado.huella !== pedido.huella) {
          throw new ErrorHttp(422, 'CLAVE_IDEMPOTENCIA_REUTILIZADA', `La ${ENCABEZADO_IDEMPOTENCIA} ya se usó con otro pedido`);
        }
        res.setHeader(ENCABEZADO_REPETIDA, 'true');
        res.status(guardado.estado).json(guardado.cuerpo);
      };

      // Reintento de algo que ya terminó: no hace falta el cerrojo.
      const previo = await almacen.buscar(pedido.alcance, pedido.clave);
      if (previo) return responderGuardado(previo);

      const nombre = `${pedido.alcance}:${pedido.clave}`;
      let token: string | null;
      try {
        token = await cerrojo.tomar(nombre, ttlEnVueloMs);
      } catch {
        // Falla cerrado: sin el cerrojo no hay deduplicación, así que no se procesa.
        throw new ErrorHttp(503, 'IDEMPOTENCIA_NO_DISPONIBLE', 'No se pudo verificar la Idempotency-Key; reintentá');
      }
      if (!token) {
        res.setHeader('Retry-After', '1');
        throw new ClaveIdempotenciaEnCurso();
      }
      const soltar = () => cerrojo.soltar(nombre, token).catch(() => {});

      // Entre la búsqueda y el cerrojo pudo haber terminado otro pedido con la misma clave.
      const terminado = await almacen.buscar(pedido.alcance, pedido.clave);
      if (terminado) {
        await soltar();
        return responderGuardado(terminado);
      }

      let cuerpo: unknown;
      const json = res.json.bind(res);
      res.json = ((valor: unknown) => {
        cuerpo = valor;
        return json(valor);
      }) as typeof res.json;
      res.once('close', () => {
        const guardar =
          res.statusCode === estado && !pedido.registrado && cuerpo !== undefined
            ? almacen.guardar({ ...pedido, cuerpo: JSON.parse(JSON.stringify(cuerpo)) }).catch(() => {})
            : Promise.resolve();
        void guardar.then(soltar);
      });

      contexto.run(pedido, next);
    };
}

// Compara y borra en un solo paso: si el cerrojo venció y lo tomó otro pedido, no se lo sacamos.
const SOLTAR = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

export function cerrojoRedis(redis: Redis, prefijo: string): CerrojoEnVuelo {
  return {
    async tomar(nombre, ttlMs) {
      const token = randomUUID();
      const r = await redis.set(`${prefijo}${nombre}`, token, 'PX', ttlMs, 'NX');
      return r === 'OK' ? token : null;
    },
    async soltar(nombre, token) {
      await redis.eval(SOLTAR, 1, `${prefijo}${nombre}`, token);
    },
  };
}

/** Para tests y para la persistencia en memoria. */
export class CerrojoMemoria implements CerrojoEnVuelo {
  private readonly tomados = new Map<string, { token: string; vence: number }>();

  async tomar(nombre: string, ttlMs: number) {
    const actual = this.tomados.get(nombre);
    if (actual && actual.vence > Date.now()) return null;
    const token = randomUUID();
    this.tomados.set(nombre, { token, vence: Date.now() + ttlMs });
    return token;
  }

  async soltar(nombre: string, token: string) {
    if (this.tomados.get(nombre)?.token === token) this.tomados.delete(nombre);
  }
}

export class AlmacenIdempotenciaMemoria implements AlmacenIdempotencia {
  private readonly registros = new Map<string, RegistroIdempotencia>();

  async buscar(alcance: string, clave: string) {
    return this.registros.get(`${alcance}:${clave}`) ?? null;
  }

  async guardar(registro: RegistroIdempotencia) {
    const id = `${registro.alcance}:${registro.clave}`;
    if (!this.registros.has(id)) this.registros.set(id, registro);
  }
}
