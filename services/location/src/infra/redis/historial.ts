import { hostname } from 'node:os';
import type { Logger } from '@viajes/platform';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '../db/generated/client.js';
import { GRUPO_HISTORIAL, type ClavesUbicacion } from './claves.js';

export interface EntradaHistorial {
  /** Id de la entrada del stream: es la clave de idempotencia de la fila. */
  streamId: string;
  choferId: string;
  lat: number;
  lng: number;
  registradoEn: Date;
}

/** Puerto de salida del historial. Tiene que ser idempotente por `streamId`. */
export interface EscritorHistorial {
  escribir(entradas: EntradaHistorial[]): Promise<void>;
}

/**
 * Inserta el lote en `pings`. `skipDuplicates` + `stream_id` único: si un lote se escribió pero no
 * se llegó a confirmar (caída del proceso, de Redis o de la red), reescribirlo no duplica filas.
 */
export class EscritorHistorialPrisma implements EscritorHistorial {
  constructor(private readonly prisma: PrismaClient) {}

  async escribir(entradas: EntradaHistorial[]): Promise<void> {
    await this.prisma.ping.createMany({
      data: entradas.map((e) => ({ choferId: e.choferId, lat: e.lat, lng: e.lng, registradoEn: e.registradoEn, streamId: e.streamId })),
      skipDuplicates: true,
    });
  }
}

type EntradaCruda = [id: string, campos: string[]];
type LecturaStream = [stream: string, entradas: EntradaCruda[]][] | null;

function aEntrada([streamId, campos]: EntradaCruda): EntradaHistorial | null {
  const v: Record<string, string> = {};
  for (let i = 0; i + 1 < campos.length; i += 2) v[campos[i] as string] = campos[i + 1] as string;
  if (!v['c'] || v['la'] === undefined || v['ln'] === undefined || !v['t']) return null;
  return { streamId, choferId: v['c'], lat: Number(v['la']), lng: Number(v['ln']), registradoEn: new Date(Number(v['t'])) };
}

export interface OpcionesConsumidor {
  lote: number;
  esperaMs: number;
  /** Cada cuánto se reclaman entradas abandonadas por otro consumidor, y desde qué inactividad. */
  reclamoMs: number;
  maxCola: number;
  nombre?: string;
}

export interface EstadoHistorial {
  enCola: number;
  pendientes: number;
  descartados: number;
  ocupacion: number;
  maxCola: number;
}

const ESPERA_MAX_REINTENTO_MS = 5000;

/**
 * Consumidor del stream del historial (al menos una vez, sin duplicados gracias a `stream_id`).
 * En cada vuelta:
 *  1. reintenta sus propios pendientes (XREADGROUP desde 0): lo que leyó y no pudo escribir;
 *  2. si no tiene, lee nuevos con espera (XREADGROUP > BLOCK) en su conexión propia;
 *  3. cada `reclamoMs`, XAUTOCLAIM de lo que otro consumidor dejó pendiente (una instancia que murió).
 * Si Postgres falla, no confirma nada: las entradas quedan pendientes y se reintentan con espera
 * creciente (hasta 5 s). Confirma (XACK) y borra (XDEL) solo después de escribir.
 */
export class ConsumidorHistorial {
  readonly nombre: string;
  private corriendo = false;
  private bucle: Promise<void> | null = null;
  private ultimoReclamo = 0;
  private esperaReintento = 100;
  private ultimoAvisoDescartes = 0;
  private descartesAvisados = 0;
  private avisoOcupacion = false;

  constructor(
    private readonly redis: Redis,
    private readonly bloqueante: Redis,
    private readonly claves: ClavesUbicacion,
    private readonly escritor: EscritorHistorial,
    private readonly opciones: OpcionesConsumidor,
    private readonly logger: Logger,
  ) {
    this.nombre = opciones.nombre ?? `${hostname()}-${process.pid}`;
  }

  /** Crea el grupo si no existe (desde el principio del stream). */
  async preparar(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.claves.historial, GRUPO_HISTORIAL, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
    }
  }

  iniciar(): void {
    if (this.corriendo) return;
    this.corriendo = true;
    this.bucle = this.correr();
  }

  /**
   * Apagado ordenado: termina la vuelta en curso y vacía lo que haya (pendientes propios y entradas
   * todavía no leídas), sin esperar y con un plazo máximo. Lo que no pueda escribir (por ejemplo,
   * Postgres caído) queda en Redis: lo recupera la próxima instancia (ver docs/location.md).
   */
  async detener(plazoMs = 5000): Promise<void> {
    this.corriendo = false;
    await this.bucle;
    const limite = Date.now() + plazoMs;
    while (Date.now() < limite) {
      const n = await this.procesarPropios()
        .then((propias) => (propias > 0 ? propias : this.procesarNuevos(0)))
        .catch((err: unknown) => {
          this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'historial: quedan entradas sin escribir al apagar');
          return 0;
        });
      if (n === 0) return;
    }
  }

  private async correr(): Promise<void> {
    await this.preparar().catch((err: unknown) => this.logger.warn({ err: String(err) }, 'historial: no se pudo crear el grupo'));
    while (this.corriendo) {
      try {
        await this.unaVuelta();
        this.esperaReintento = 100;
      } catch (err) {
        this.logger.warn({ err: err instanceof Error ? err.message : String(err), reintentoMs: this.esperaReintento }, 'historial: no se pudo escribir el lote');
        await new Promise((r) => setTimeout(r, this.esperaReintento));
        this.esperaReintento = Math.min(this.esperaReintento * 2, ESPERA_MAX_REINTENTO_MS);
      }
    }
  }

  /** Una vuelta del bucle. Pública para los tests. Devuelve cuántas entradas escribió. */
  async unaVuelta(): Promise<number> {
    if (Date.now() - this.ultimoReclamo >= this.opciones.reclamoMs) {
      this.ultimoReclamo = Date.now();
      await this.vigilarCola();
      const reclamadas = await this.reclamarAbandonadas(this.opciones.reclamoMs);
      if (reclamadas > 0) return reclamadas;
    }
    const propias = await this.procesarPropios();
    if (propias > 0) return propias;
    return this.procesarNuevos(this.opciones.esperaMs);
  }

  /** Reintenta lo que este consumidor ya leyó y no confirmó. */
  async procesarPropios(): Promise<number> {
    const r = (await this.redis.xreadgroup(
      'GROUP', GRUPO_HISTORIAL, this.nombre, 'COUNT', this.opciones.lote, 'STREAMS', this.claves.historial, '0',
    )) as LecturaStream;
    return this.procesar(r?.[0]?.[1] ?? []);
  }

  /**
   * Lee entradas nuevas. Con `esperaMs > 0` espera en la conexión bloqueante; con 0 no espera y usa
   * la conexión común (para vaciar la cola al apagar).
   */
  async procesarNuevos(esperaMs: number): Promise<number> {
    const r = (
      esperaMs > 0
        ? await this.bloqueante.xreadgroup(
            'GROUP', GRUPO_HISTORIAL, this.nombre, 'COUNT', this.opciones.lote, 'BLOCK', esperaMs, 'STREAMS', this.claves.historial, '>',
          )
        : await this.redis.xreadgroup(
            'GROUP', GRUPO_HISTORIAL, this.nombre, 'COUNT', this.opciones.lote, 'STREAMS', this.claves.historial, '>',
          )
    ) as LecturaStream;
    return this.procesar(r?.[0]?.[1] ?? []);
  }

  /** Toma entradas que otro consumidor dejó sin confirmar por más de `inactividadMs`. */
  async reclamarAbandonadas(inactividadMs: number): Promise<number> {
    const [, entradas, borradas] = (await this.redis.xautoclaim(
      this.claves.historial, GRUPO_HISTORIAL, this.nombre, inactividadMs, '0-0', 'COUNT', this.opciones.lote,
    )) as [string, EntradaCruda[], string[]];
    // Entradas pendientes que ya no existen en el stream: solo hay que sacarlas de pendientes.
    if (borradas?.length) await this.redis.xack(this.claves.historial, GRUPO_HISTORIAL, ...borradas);
    const n = await this.procesar(entradas.filter((e) => e && e[1]));
    if (n > 0) this.logger.info({ entradas: n }, 'historial: recuperadas entradas de otro consumidor');
    return n;
  }

  private async procesar(crudas: EntradaCruda[]): Promise<number> {
    if (crudas.length === 0) return 0;
    const entradas = crudas.map(aEntrada).filter((e): e is EntradaHistorial => e !== null);
    // Si Postgres falla, esto lanza y no se confirma nada: las entradas quedan pendientes.
    if (entradas.length) await this.escritor.escribir(entradas);
    const ids = crudas.map(([id]) => id);
    await this.redis.multi().xack(this.claves.historial, GRUPO_HISTORIAL, ...ids).xdel(this.claves.historial, ...ids).exec();
    return entradas.length;
  }

  async estado(): Promise<EstadoHistorial> {
    const [[, enCola], [, resumen], [, descartados]] = (await this.redis
      .multi()
      .xlen(this.claves.historial)
      .xpending(this.claves.historial, GRUPO_HISTORIAL)
      .get(this.claves.descartados)
      .exec()
      .catch(() => [[null, 0], [null, [0]], [null, '0']])) as [[unknown, number], [unknown, [number] | null], [unknown, string | null]];
    const pendientes = Array.isArray(resumen) ? Number(resumen[0] ?? 0) : 0;
    return {
      enCola: Number(enCola ?? 0),
      pendientes,
      descartados: Number(descartados ?? 0),
      ocupacion: Number(enCola ?? 0) / this.opciones.maxCola,
      maxCola: this.opciones.maxCola,
    };
  }

  /** Avisa en el log al pasar el 80 % de la cola y, como mucho una vez por minuto, si hay descartes. */
  private async vigilarCola(): Promise<void> {
    const e = await this.estado();
    if (e.ocupacion >= 0.8 && !this.avisoOcupacion) {
      this.logger.warn({ enCola: e.enCola, maxCola: e.maxCola }, 'historial: la cola pasó el 80 %');
    }
    this.avisoOcupacion = e.ocupacion >= 0.8;
    if (e.descartados > this.descartesAvisados && Date.now() - this.ultimoAvisoDescartes >= 60_000) {
      this.logger.error({ descartados: e.descartados }, 'historial: cola llena, se están descartando entradas del historial');
      this.ultimoAvisoDescartes = Date.now();
      this.descartesAvisados = e.descartados;
    }
  }
}
