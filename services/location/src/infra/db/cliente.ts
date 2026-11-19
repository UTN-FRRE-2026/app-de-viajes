import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

export function crearPrisma(url: string, maxConexiones: number): PrismaClient {
  const adapter = new PrismaPg({ connectionString: url, max: maxConexiones });
  // Con LOCATION_LOG_SQL=1 se ve cada query.
  const log = process.env.LOCATION_LOG_SQL === '1' ? (['query'] as const) : [];
  return new PrismaClient({ adapter, log: [...log] });
}
