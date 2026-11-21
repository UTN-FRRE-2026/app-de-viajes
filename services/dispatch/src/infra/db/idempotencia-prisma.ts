import { ClaveIdempotenciaEnCurso, type AlmacenIdempotencia, type RegistroPendiente } from '@viajes/platform';
import type { Prisma, PrismaClient } from './generated/client.js';

/** Lecturas del middleware, y el respaldo para lo que no pasa por `enTransaccion`. */
export class AlmacenIdempotenciaPrisma implements AlmacenIdempotencia {
  constructor(private readonly prisma: PrismaClient) {}

  async buscar(alcance: string, clave: string) {
    const r = await this.prisma.registroIdempotencia.findUnique({ where: { alcance_clave: { alcance, clave } } });
    return r ? { alcance, clave, huella: r.huella, estado: r.estado, cuerpo: r.respuesta } : null;
  }

  async guardar({ alcance, clave, huella, estado, cuerpo }: Parameters<AlmacenIdempotencia['guardar']>[0]) {
    await this.prisma.$executeRaw`
      INSERT INTO idempotency_keys (scope, key, request_hash, status_code, response)
      VALUES (${alcance}, ${clave}, ${huella}, ${estado}, ${JSON.stringify(cuerpo)}::json)
      ON CONFLICT DO NOTHING`;
  }
}

/**
 * Dentro de la transacción del efecto: si el pedido trae Idempotency-Key, el registro confirma junto
 * con el efecto o no confirma. El cuerpo es el resultado del caso de uso, que es lo que responde la ruta.
 * Si la clave ya está, otro pedido con la misma clave confirmó primero (se le venció el cerrojo de
 * Redis): esta transacción se deshace y el efecto no se repite.
 */
export async function registrarEnTransaccion(tx: Prisma.TransactionClient, pendiente: RegistroPendiente, resultado: unknown) {
  const { alcance, clave, huella, estado } = pendiente;
  const filas = await tx.$queryRaw<{ key: string }[]>`
    INSERT INTO idempotency_keys (scope, key, request_hash, status_code, response)
    VALUES (${alcance}, ${clave}, ${huella}, ${estado}, ${JSON.stringify(resultado)}::json)
    ON CONFLICT DO NOTHING
    RETURNING key`;
  if (filas.length === 0) throw new ClaveIdempotenciaEnCurso();
}
