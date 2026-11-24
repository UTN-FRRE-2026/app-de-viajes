// node deploy/desplegar.mjs <dominio>
//
// Levanta (o actualiza) el entorno publicado en esta máquina. Se puede correr las veces que haga falta:
// cada paso es idempotente y ninguno borra datos. Necesita Node 22, Docker con Compose 2.24 o más, y
// las dependencias instaladas (`npm ci`). Ver docs/despliegue.md.
//
//  1. deploy/.env.produccion con secretos nuevos, si todavía no existe.
//  2. Postgres y Redis.
//  3. PostGIS en la base de dispatch.
//  4. Cliente de Prisma y migraciones de las tres bases (desde el host, por 127.0.0.1).
//  5. Usuarios de prueba (seed de identity).
//  6. Los tres servicios, nginx y Caddy, con las imágenes recién construidas.
//  7. La demo de flotas y zonas (sin ella, toda solicitud da 422 ORIGEN_FUERA_DE_ZONA).
import { existsSync } from 'node:fs';
import { correr, entornoCon, leerEnv, SERVICIOS } from '../scripts/lib/entorno.mjs';

const dominio = process.argv[2];
const paso = (n, texto) => console.log(`\n[desplegar ${n}/7] ${texto}`);
const COMPOSE = ['compose', '-f', 'docker-compose.yml', '-f', 'deploy/compose.produccion.yml', '--env-file', 'deploy/.env.produccion'];
const RUTA = 'deploy/.env.produccion';

try {
  paso(1, 'deploy/.env.produccion');
  if (!existsSync(RUTA)) {
    if (!dominio) throw new Error('falta el dominio: node deploy/desplegar.mjs <dominio>   (o :80 detrás de un túnel)');
    correr('node', ['deploy/preparar-env.mjs', dominio]);
  } else {
    console.log('  ya existe: se usan sus secretos');
  }
  const valores = leerEnv(RUTA);
  // Lo del archivo manda sobre el entorno de la terminal: un DATABASE_URL de desarrollo exportado no
  // tiene que terminar migrando otra base.
  const env = { ...entornoCon(valores), ...valores };

  paso(2, 'Postgres y Redis');
  correr('docker', [...COMPOSE, 'up', '-d', '--wait', 'postgres', 'redis'], { env });

  paso(3, 'Contraseñas de las bases y PostGIS');
  const psql = (base, sql) =>
    correr('docker', [...COMPOSE, 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', base, '-v', 'ON_ERROR_STOP=1'], {
      env,
      entrada: sql,
      silencioso: true,
    });
  // El init las pone solo con el volumen vacío. Si el volumen ya existía (con las de desarrollo), se
  // alinean acá con las del archivo. Son base64url: no llevan comillas que escapar.
  psql(
    'postgres',
    SERVICIOS.map(({ nombre }) => `ALTER ROLE ${nombre}_svc PASSWORD '${valores[`DB_PASSWORD_${nombre.toUpperCase()}`]}';`).join('\n'),
  );
  psql('dispatch', 'CREATE EXTENSION IF NOT EXISTS postgis;');

  paso(4, 'Prisma y migraciones');
  for (const { nombre } of SERVICIOS) {
    console.log(`  ${nombre}`);
    correr('npm', ['run', 'prisma:generate', '-w', `@viajes/${nombre}`, '--silent'], { env, silencioso: true });
    correr('npm', ['run', 'migrate:deploy', '-w', `@viajes/${nombre}`, '--silent'], { env, silencioso: true });
  }

  paso(5, 'Usuarios de prueba');
  correr('npm', ['run', 'seed', '--silent'], { env: { ...env, NODE_ENV: 'development' } });

  paso(6, 'Servicios, nginx y Caddy');
  correr('docker', [...COMPOSE, 'up', '-d', '--build', '--wait'], { env });

  const url = valores.DOMINIO === ':80' ? 'http://localhost' : `https://${valores.DOMINIO}`;
  paso(7, `Demo de flotas y zonas contra ${url}`);
  correr('node', ['scripts/demo-flotas.mjs', url], { env });

  console.log(`
Listo: ${url}
  Comprobar:        npm run web:probar -- ${url} deploy/.env.produccion
  Logs:             docker ${COMPOSE.join(' ')} logs -f
  Usuarios de prueba y su contraseña (IDENTITY_SEED_CONTRASENA de deploy/.env.produccion): README.
  Congelar:         git tag -a congelado -m "Entorno del ataque cruzado" && git push origin congelado`);
} catch (err) {
  console.error(`\n[desplegar] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
