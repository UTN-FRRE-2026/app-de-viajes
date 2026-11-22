import { ClaveIdempotenciaEnCurso, type AlmacenIdempotencia, type RegistroPendiente } from './idempotencia.js';

/**
 * Los registros de Idempotency-Key en Postgres, para cualquier servicio. Cada servicio tiene su
 * propia tabla `idempotency_keys` en su base (con la misma forma, en su migración) y le pasa acá su
 * cliente de Prisma o la transacción en curso: alcanza con que tengan `$queryRaw` y `$executeRaw`.
 */
export interface ConsultasSql {
  $queryRaw<T = unknown>(consulta: TemplateStringsArray, ...valores: unknown[]): PromiseLike<T>;
  $executeRaw(consulta: TemplateStringsArray, ...valores: unknown[]): PromiseLike<number>;
}

interface FilaIdempotencia {
  request_hash: string;
  status_code: number;
  response: unknown;
}

/** Lecturas del middleware, y el respaldo para las rutas cuyo efecto no registra en su transacción. */
export function almacenIdempotenciaSql(db: ConsultasSql): AlmacenIdempotencia {
  return {
    async buscar(alcance, clave) {
      const [fila] = await db.$queryRaw<FilaIdempotencia[]>`
        SELECT request_hash, status_code, response FROM idempotency_keys WHERE scope = ${alcance} AND key = ${clave}`;
      return fila ? { alcance, clave, huella: fila.request_hash, estado: fila.status_code, cuerpo: fila.response } : null;
    },
    async guardar({ alcance, clave, huella, estado, cuerpo }) {
      await db.$executeRaw`
        INSERT INTO idempotency_keys (scope, key, request_hash, status_code, response)
        VALUES (${alcance}, ${clave}, ${huella}, ${estado}, ${JSON.stringify(cuerpo)}::json)
        ON CONFLICT DO NOTHING`;
    },
  };
}

/**
 * Dentro de la transacción del efecto: si el pedido trae Idempotency-Key, el registro confirma junto
 * con el efecto o no confirma. El cuerpo es el resultado del caso de uso, que es lo que responde la ruta.
 * Si la clave ya está, otro pedido con la misma clave confirmó primero (se le venció el cerrojo de
 * Redis): esta transacción se deshace y el efecto no se repite.
 */
export async function registrarIdempotenciaEnTransaccion(tx: ConsultasSql, pendiente: RegistroPendiente, resultado: unknown) {
  const { alcance, clave, huella, estado } = pendiente;
  const filas = await tx.$queryRaw<{ key: string }[]>`
    INSERT INTO idempotency_keys (scope, key, request_hash, status_code, response)
    VALUES (${alcance}, ${clave}, ${huella}, ${estado}, ${JSON.stringify(resultado)}::json)
    ON CONFLICT DO NOTHING
    RETURNING key`;
  if (filas.length === 0) throw new ClaveIdempotenciaEnCurso();
}

export interface OpcionesPurga {
  /** Cuánto se guarda cada registro. Pasado ese tiempo, la misma clave vuelve a ejecutar el pedido. */
  retencionMs: number;
  /** Filas por DELETE: lotes chicos, para no bloquear la tabla ni generar una transacción enorme. */
  lote?: number;
  /** Lotes por pasada, como mucho. Si queda más, sigue en la próxima. */
  maxLotes?: number;
}

/**
 * Borra los registros de Idempotency-Key más viejos que la retención. Sin esto, `idempotency_keys`
 * crece con cada pedido para siempre. Lo corre cada servidor cada IDEMPOTENCIA_PURGA_INTERVALO_MS.
 *
 * - Por lotes, los más viejos primero, usando el índice por `created_at`.
 * - `FOR UPDATE SKIP LOCKED`: con varias instancias del servicio, cada una borra filas distintas sin
 *   esperar a la otra.
 * - La hora es la de la base (`now()`), la misma que puso `created_at`.
 *
 * La retención es un mínimo: una clave se respeta **al menos** ese tiempo (puede durar hasta la
 * próxima pasada). Devuelve cuántos borró.
 */
export function purgarIdempotenciaSql(db: ConsultasSql, { retencionMs, lote = 1000, maxLotes = 20 }: OpcionesPurga) {
  return async (): Promise<number> => {
    let total = 0;
    for (let i = 0; i < maxLotes; i++) {
      const borrados = await db.$executeRaw`
        DELETE FROM idempotency_keys
        WHERE (scope, key) IN (
          SELECT scope, key
          FROM idempotency_keys
          WHERE created_at < now() - ${retencionMs}::float8 * interval '1 millisecond'
          ORDER BY created_at
          LIMIT ${lote}::int
          FOR UPDATE SKIP LOCKED
        )`;
      total += borrados;
      if (borrados < lote) break;
    }
    return total;
  };
}
