import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const URL_BD_TEST =
  process.env.LOCATION_DATABASE_URL_TEST ?? 'postgresql://location_svc:location_dev@localhost:5434/location_test';

/** Se corre una vez antes de los tests contra Postgres: deja la base de test con todas las migraciones. */
export default function prepararBd() {
  const cwd = fileURLToPath(new URL('../..', import.meta.url));
  try {
    execSync('npx prisma migrate deploy', {
      cwd,
      env: { ...process.env, LOCATION_DATABASE_URL: URL_BD_TEST },
      stdio: 'pipe',
    });
  } catch (err) {
    const salida = (err as { stderr?: Buffer; stdout?: Buffer }).stderr?.toString() ?? String(err);
    throw new Error(
      `No pude migrar la base de test (${URL_BD_TEST}). ¿Está levantado Postgres y existe location_test? (ver docs/location.md)\n${salida}`,
    );
  }
}
