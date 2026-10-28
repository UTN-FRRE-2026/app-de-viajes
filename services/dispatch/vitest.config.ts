import { defineConfig } from 'vitest/config';

const resolve = { conditions: ['development'] };

export default defineConfig({
  resolve,
  test: {
    projects: [
      {
        resolve,
        test: { name: 'dominio', include: ['tests/dominio/**/*.test.ts'] },
      },
      {
        resolve,
        test: {
          name: 'postgres',
          include: ['tests/{integracion,concurrencia,seguridad}/**/*.test.ts'],
          globalSetup: ['tests/soporte/preparar-bd.ts'],
          // Comparten la misma base: los archivos corren de a uno.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
