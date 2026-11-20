import { readdir } from 'node:fs/promises';
import type { ChequeoListo } from '@viajes/platform';
import type { PrismaClient } from './generated/client.js';

/**
 * Un chequeo que no responde también es un fallo. Sin esto, con Postgres colgado (no caído: acepta
 * la conexión y no contesta) /ready quedaba esperando en vez de responder 503.
 */
export function conTiempoLimite(chequeo: ChequeoListo, ms = 2000): ChequeoListo {
  return {
    nombre: chequeo.nombre,
    chequear: async () => {
      let temporizador: NodeJS.Timeout | undefined;
      const limite = new Promise<never>((_, rechazar) => {
        temporizador = setTimeout(() => rechazar(new Error(`sin respuesta en ${ms} ms`)), ms);
      });
      try {
        await Promise.race([chequeo.chequear(), limite]);
      } finally {
        clearTimeout(temporizador);
      }
    },
  };
}

export function chequeosBase(prisma: PrismaClient, carpetaMigraciones: string): ChequeoListo[] {
  return [
    {
      nombre: 'postgres',
      chequear: async () => {
        await prisma.$queryRaw`SELECT 1`;
      },
    },
    {
      nombre: 'migraciones',
      chequear: async () => {
        const entradas = await readdir(carpetaMigraciones, { withFileTypes: true });
        const esperadas = entradas.filter((e) => e.isDirectory()).map((e) => e.name);
        const aplicadas = await prisma.$queryRaw<{ migration_name: string }[]>`
          SELECT migration_name FROM _prisma_migrations
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
        const hechas = new Set(aplicadas.map((a) => a.migration_name));
        const pendientes = esperadas.filter((m) => !hechas.has(m));
        if (pendientes.length > 0) throw new Error(`migraciones pendientes: ${pendientes.join(', ')}`);
      },
    },
  ];
}
