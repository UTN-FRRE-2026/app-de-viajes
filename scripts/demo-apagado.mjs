// npm run demo:apagado: SIGTERM durante un pedido lento (verificación 3 del PLAN, bloque 3).
//
// Levanta un dispatch propio, sin base ni Redis (persistencia en memoria) y con el mapa simulado lento
// (4 s por pedido), le pide una estimación de tarifa y, a mitad de camino, le manda SIGTERM. Muestra:
// - que el pedido en curso termina bien (200) aunque el proceso ya recibió la señal;
// - que una conexión nueva después de la señal se rechaza (dejó de aceptar);
// - el log del apagado ordenado y el código de salida (0).
//
// No necesita nada levantado: el token lo firma este script con una clave propia y sirve el JWKS él
// mismo. En Windows, SIGTERM no existe (Node mata el proceso de una): correrlo en WSL o Linux.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { RAIZ } from './lib/entorno.mjs';

if (process.platform === 'win32') {
  console.error('En Windows no hay SIGTERM (Node termina el proceso sin avisarle). Correlo en WSL o Linux.');
  process.exit(1);
}

const PUERTO = Number(process.env.PUERTO_DEMO ?? 3195);
const DEMORA_MS = 4000;
const SENAL_A_LOS_MS = 1000;
const t0 = Date.now();
const reloj = () => `${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5)} s`;
const decir = (texto) => console.log(`[${reloj()}] ${texto}`);

// 1. Un JWKS propio y un token de pasajero firmado con esa clave.
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'demo', alg: 'RS256', use: 'sig' };
const jwks = createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise((r) => jwks.listen(0, '127.0.0.1', r));
const token = await new SignJWT({ rol: 'pasajero' })
  .setProtectedHeader({ alg: 'RS256', kid: 'demo' })
  .setSubject(randomUUID())
  .setIssuer('demo-apagado')
  .setAudience('demo-apagado')
  .setExpirationTime('5m')
  .sign(privateKey);

// 2. dispatch, con el mapa lento. Todo en memoria: no toca la base ni Redis de desarrollo.
const secreto = () => randomBytes(32).toString('base64url');
const hijo = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', 'services/dispatch/src/servidor.ts'], {
  cwd: RAIZ,
  env: {
    PATH: process.env.PATH,
    PUERTO: String(PUERTO),
    NIVEL_LOG: 'info',
    DISPATCH_PERSISTENCIA: 'memoria',
    DISPATCH_BUSCADOR: 'fijo',
    JWKS_URL: `http://127.0.0.1:${jwks.address().port}/jwks.json`,
    JWT_ISSUER: 'demo-apagado',
    JWT_AUDIENCE: 'demo-apagado',
    METRICAS_TOKEN: secreto(),
    IDENTITY_URL: 'http://127.0.0.1:9',
    IDENTITY_TOKEN_SERVICIO: secreto(),
    MAPAS_LATENCIA_SIMULADA_MS: String(DEMORA_MS),
    MAPAS_TIMEOUT_MS: String(DEMORA_MS * 2),
    APAGADO_TIMEOUT_MS: String(DEMORA_MS * 3),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const salida = new Promise((r) => hijo.on('exit', (codigo, senal) => r({ codigo, senal })));
let listo;
const escuchando = new Promise((r) => (listo = r));
for (const flujo of [hijo.stdout, hijo.stderr]) {
  let resto = '';
  flujo.setEncoding('utf8');
  flujo.on('data', (parte) => {
    resto += parte;
    const lineas = resto.split('\n');
    resto = lineas.pop() ?? '';
    for (const linea of lineas) {
      try {
        const l = JSON.parse(linea);
        const extra = l.metodo ? ` ${l.metodo} ${l.ruta} → ${l.estado} en ${l.duracionMs} ms` : l.senal ? ` (${l.senal})` : '';
        decir(`  dispatch: ${l.msg}${extra}`);
        if (l.msg === 'dispatch escuchando') listo();
      } catch {
        if (linea.trim()) decir(`  dispatch: ${linea}`);
      }
    }
  });
}

try {
  await Promise.race([escuchando, salida.then(() => Promise.reject(new Error('dispatch terminó antes de arrancar')))]);
  const url = `http://127.0.0.1:${PUERTO}/tarifas/estimacion?origenLat=-34.6037&origenLng=-58.3816&destinoLat=-34.5875&destinoLng=-58.4207`;

  // 3. El pedido lento.
  decir(`pido una estimación (el mapa simulado tarda ${DEMORA_MS / 1000} s)`);
  const inicio = Date.now();
  const lento = fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then(
    async (r) => ({ estado: r.status, cuerpo: await r.json(), ms: Date.now() - inicio }),
    (err) => ({ error: err.message, ms: Date.now() - inicio }),
  );

  // 4. SIGTERM a mitad de camino, y una conexión nueva después.
  await new Promise((r) => setTimeout(r, SENAL_A_LOS_MS));
  decir('mando SIGTERM a dispatch');
  hijo.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  const nuevo = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then(
    (r) => `respondió ${r.status} (no debería)`,
    () => 'rechazada: dispatch ya no acepta conexiones',
  );
  decir(`conexión nueva después de la señal: ${nuevo}`);

  const r = await lento;
  decir(r.error ? `el pedido lento FALLÓ: ${r.error}` : `el pedido lento terminó: ${r.estado} en ${(r.ms / 1000).toFixed(1)} s (tarifa ${r.cuerpo.tarifaCentavos} centavos)`);
  const { codigo, senal } = await salida;
  decir(`dispatch salió con código ${codigo ?? senal}`);

  const bien = !r.error && r.estado === 200 && codigo === 0;
  console.log(bien ? '\nOK: el pedido en curso terminó antes de salir, y el proceso salió limpio.' : '\nFALLA: revisar el log de arriba.');
  process.exitCode = bien ? 0 : 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  hijo.kill('SIGKILL');
  process.exitCode = 1;
} finally {
  jwks.close();
}
