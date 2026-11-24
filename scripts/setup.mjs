// npm run setup: deja el entorno de desarrollo listo para `npm test`, `npm run dev`, `npm start` o
// `docker compose up -d --build`. Se puede correr las veces que haga falta: cada paso es idempotente
// y ninguno borra datos.
//
//   npm run setup                 todo, incluido levantar Postgres y Redis con Docker Compose
//   npm run setup -- --sin-docker Postgres y Redis los provee otro (por ejemplo, el CI)
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { completarEnv, correr, entornoCon, leerEnv, RUTA_EJEMPLO, RUTA_ENV, SERVICIOS } from './lib/entorno.mjs';

const sinDocker = process.argv.includes('--sin-docker');
const paso = (n, texto) => console.log(`\n[setup ${n}/6] ${texto}`);

/** Bases de cada servicio: la de desarrollo y la de test, con su usuario dueño. */
const BASES = SERVICIOS.flatMap(({ nombre }) => [
  { base: nombre, usuario: `${nombre}_svc` },
  { base: `${nombre}_test`, usuario: `${nombre}_svc` },
]);

function prepararEnv() {
  if (!existsSync(RUTA_ENV)) {
    copyFileSync(RUTA_EJEMPLO, RUTA_ENV);
    console.log('  .env creado a partir de .env.example');
    return;
  }
  const { texto, agregadas } = completarEnv(readFileSync(RUTA_ENV, 'utf8'), readFileSync(RUTA_EJEMPLO, 'utf8'));
  if (agregadas.length === 0) {
    console.log('  .env ya tiene todas las variables de .env.example');
    return;
  }
  writeFileSync(RUTA_ENV, texto);
  console.log(`  .env tenía variables de menos; se agregaron con los valores de .env.example: ${agregadas.join(', ')}`);
}

function psql(sql, base = 'postgres') {
  return correr('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', base, '-v', 'ON_ERROR_STOP=1', '-tA'], {
    entrada: sql,
    silencioso: true,
  });
}

/** Las bases que usan PostGIS (las zonas de dispatch): la de desarrollo y la de test. */
const BASES_POSTGIS = ['dispatch', 'dispatch_test'];

/**
 * PostGIS en las bases de dispatch. Crear la extensión necesita superusuario y dispatch_svc no lo es:
 * se instala acá como postgres (el init lo hace en un volumen nuevo). IF NOT EXISTS: si ya está, no
 * cambia nada; la migración de zonas solo la usa.
 */
function instalarPostgis() {
  for (const base of BASES_POSTGIS) psql('CREATE EXTENSION IF NOT EXISTS postgis;', base);
  console.log(`  PostGIS en ${BASES_POSTGIS.join(' y ')}`);
}

/**
 * El script de init de Postgres crea las bases solo cuando el volumen está vacío. Si el volumen es
 * anterior a un servicio (location, las bases de test), faltan: se crean acá, sin borrar nada.
 * Usuarios con la contraseña de desarrollo `<servicio>_dev`, igual que el init.
 */
function crearBasesQueFalten() {
  const existentes = new Set(psql('SELECT datname FROM pg_database;').split(/\r?\n/).filter(Boolean));
  const roles = new Set(psql('SELECT rolname FROM pg_roles;').split(/\r?\n/).filter(Boolean));
  const sql = [];
  for (const { nombre } of SERVICIOS) {
    const usuario = `${nombre}_svc`;
    if (!roles.has(usuario)) sql.push(`CREATE ROLE ${usuario} LOGIN PASSWORD '${nombre}_dev';`);
  }
  const faltan = BASES.filter(({ base }) => !existentes.has(base));
  for (const { base, usuario } of faltan) {
    sql.push(`CREATE DATABASE ${base} OWNER ${usuario};`, `REVOKE ALL ON DATABASE ${base} FROM PUBLIC;`);
  }
  if (sql.length) psql(sql.join('\n'));
  console.log(faltan.length ? `  bases creadas: ${faltan.map((b) => b.base).join(', ')}` : '  las seis bases ya existían');
}

try {
  paso(1, 'Archivo .env');
  prepararEnv();

  paso(2, 'Clave RS256 de identity');
  // Si ya hay una, el script no la toca.
  correr('npm', ['run', 'claves', '-w', '@viajes/identity', '--silent']);
  const env = entornoCon(leerEnv());

  if (sinDocker) {
    paso(3, 'Postgres y Redis: los provee otro (--sin-docker), no se levantan ni se crean bases');
  } else {
    paso(3, 'Postgres y Redis (Docker Compose)');
    try {
      correr('docker', ['compose', 'version'], { silencioso: true });
    } catch {
      throw new Error('no encuentro Docker Compose. Instalá Docker (con Compose) o usá --sin-docker si ya tenés Postgres y Redis.');
    }
    correr('docker', ['compose', 'up', '-d', '--wait', 'postgres', 'redis'], { env });
    crearBasesQueFalten();
    instalarPostgis();
  }

  paso(4, 'Cliente de Prisma de cada servicio');
  for (const { nombre } of SERVICIOS) correr('npm', ['run', 'prisma:generate', '-w', `@viajes/${nombre}`, '--silent'], { env });

  paso(5, 'Migraciones de las bases de desarrollo');
  for (const { nombre } of SERVICIOS) {
    console.log(`  ${nombre}`);
    correr('npm', ['run', 'migrate:deploy', '-w', `@viajes/${nombre}`, '--silent'], { env, silencioso: true });
  }

  paso(6, 'Usuarios de prueba (seed de identity)');
  correr('npm', ['run', 'seed', '--silent'], { env });

  console.log(`
Listo. Desde acá:
  npm test                    tests de los tres servicios
  npm run dev                 identity (3001), location (3004) y dispatch (3005) con recarga
  npm start                   lo mismo, compilado
  docker compose up -d --build  los tres en contenedores (en vez de npm run dev o npm start)`);
} catch (err) {
  console.error(`\n[setup] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
