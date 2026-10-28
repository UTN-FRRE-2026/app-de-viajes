import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

export function crearPrisma(url: string, maxConexiones: number): PrismaClient {
  const adapter = new PrismaPg({ connectionString: url, max: maxConexiones });
  // Con DISPATCH_LOG_SQL=1 se ve cada query (para mostrar el SQL de los locks en la defensa).
  const log = process.env.DISPATCH_LOG_SQL === '1' ? (['query'] as const) : [];
  return new PrismaClient({ adapter, log: [...log] });
}
