import { defineConfig, devices } from '@playwright/test';

/**
 * Los cinco flujos de PLAN 5.3, y el de la conducción simulada del chofer, contra el sistema en Docker
 * Compose (nginx en 8080), levantado con `npm run e2e:levantar` (ver docs/ci.md).
 *
 * En serie y con un solo worker: los flujos comparten los usuarios del seed, y un pasajero o un chofer
 * tienen como mucho un viaje activo.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'reporte' }]],
  outputDir: 'resultados',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_URL ?? 'http://localhost:8080',
    viewport: { width: 1440, height: 900 },
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
