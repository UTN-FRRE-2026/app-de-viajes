// npm run e2e:levantar: el sistema en Docker Compose, configurado para los flujos de Playwright, y la
// demo de flotas y zonas armada. Se puede correr las veces que haga falta.
//
// Lo que cambia respecto del Compose de desarrollo (solo mientras dure este levantado):
// - OFERTAS_SIMULTANEAS=1 y OFERTA_TTL_SEGUNDOS=6: una oferta por vez y que venza rápido, para probar
//   que pasa al siguiente chofer (flujo 3) sin esperar 15 s;
// - IDENTITY_LOGIN_MAX_POR_IP=1000: el límite de login por IP cuenta también los login correctos, y
//   los flujos entran muchas veces desde la misma IP (el límite por email sigue en 5 fallos).
// Para volver a los valores del .env: `docker compose up -d` sin estas variables.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, OFERTAS_SIMULTANEAS: '1', OFERTA_TTL_SEGUNDOS: '6', IDENTITY_LOGIN_MAX_POR_IP: '1000' };

function correr(comando, args) {
  console.log(`> ${comando} ${args.join(' ')}`);
  const r = spawnSync(comando, args, { cwd: raiz, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

correr('docker', ['compose', 'up', '-d', '--build', '--wait']);
correr('node', ['scripts/demo-flotas.mjs', ...(process.env.E2E_URL ? [process.env.E2E_URL] : [])]);
console.log('\nListo para `npm run e2e`.');
