import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const URL_BD_TEST =
  process.env.IDENTITY_DATABASE_URL_TEST ?? 'postgresql://identity_svc:identity_dev@localhost:5434/identity_test';

export const URL_REDIS_TEST = process.env.REDIS_URL_TEST ?? 'redis://localhost:6379/15';

/** Se corre una vez antes de los tests de infra: deja la base de test con todas las migraciones. */
export default function prepararBd() {
  const cwd = fileURLToPath(new URL('../..', import.meta.url));
  try {
    execSync('npx prisma migrate deploy', {
      cwd,
      env: { ...process.env, IDENTITY_DATABASE_URL: URL_BD_TEST },
      stdio: 'pipe',
    });
  } catch (err) {
    const salida = (err as { stderr?: Buffer; stdout?: Buffer }).stderr?.toString() ?? String(err);
    throw new Error(
      `No pude migrar la base de test (${URL_BD_TEST}). ¿Está levantado Postgres? (npm run infra:up)\n${salida}`,
    );
  }
}
