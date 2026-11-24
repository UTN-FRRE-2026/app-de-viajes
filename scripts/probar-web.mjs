// Prueba el contenedor web (nginx) de punta a punta, contra el Compose levantado:
//
//   docker compose up -d --build
//   node scripts/probar-web.mjs [url] [archivo .env]   (por defecto http://localhost:<WEB_PUERTO o 8080> y .env)
//
// Contra el entorno publicado: node scripts/probar-web.mjs https://<dominio> deploy/.env.produccion
//
// Revisa la página y su CSP, que la API llegue a los tres servicios, que lo interno no se publique y
// que el SSE pase sin buffer. Para el SSE entra como el pasajero del seed (`npm run setup` lo carga),
// con IDENTITY_SEED_CONTRASENA del .env. Termina con código 1 si algo falla.
import { leerEnv } from './lib/entorno.mjs';

// El .env de donde sale la contraseña del seed: el de desarrollo, o el del entorno publicado.
const env = { ...leerEnv(process.argv[3]), ...process.env };
const BASE = (process.argv[2] ?? `http://localhost:${env.WEB_PUERTO || 8080}`).replace(/\/$/, '');
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

let fallas = 0;
function revisar(nombre, ok, detalle = '') {
  console.log(`${ok ? 'ok  ' : 'FALLA'} ${nombre}${ok || !detalle ? '' : ` (${detalle})`}`);
  if (!ok) fallas++;
}

// --- La página ---------------------------------------------------------------------------------
const pagina = await fetch(`${BASE}/`);
revisar('GET / → 200 html', pagina.status === 200 && pagina.headers.get('content-type')?.startsWith('text/html'));
revisar('CSP de la página', pagina.headers.get('content-security-policy') === CSP, pagina.headers.get('content-security-policy') ?? 'sin CSP');
revisar('X-Content-Type-Options: nosniff', pagina.headers.get('x-content-type-options') === 'nosniff');
revisar('nginx no dice su versión', pagina.headers.get('server') === 'nginx', pagina.headers.get('server') ?? '');
const html = await pagina.text();
revisar('sin scripts ni estilos en línea', !/<script(?![^>]*\bsrc=)|<style|\sstyle=|\son\w+=/i.test(html));
const ruta = await fetch(`${BASE}/viaje/en-curso`);
revisar('una ruta del frontend devuelve el index.html', ruta.status === 200 && (await ruta.text()) === html);

// --- La API ------------------------------------------------------------------------------------
for (const prefijo of ['identity', 'viajes', 'ubicacion']) {
  const res = await fetch(`${BASE}/api/${prefijo}/health`);
  revisar(`GET /api/${prefijo}/health → 200`, res.status === 200, String(res.status));
  revisar(`/api/${prefijo}: la CSP es la del servicio, no la de la página`, res.headers.get('content-security-policy')?.startsWith("default-src 'none'"));
}
const jwks = await fetch(`${BASE}/api/identity/.well-known/jwks.json`);
revisar('el JWKS es público', jwks.status === 200);

const UUID = '00000000-0000-4000-8000-000000000001';
const internas = [
  `/api/identity/interno/usuarios/${UUID}`,
  '/api/ubicacion/interno/candidatos?lat=0&lng=0',
  '/api/viajes/metrics',
  '/api/identity/metrics',
  '/api/ubicacion/ready',
  '/api/identity/INTERNO/usuarios/x',
  '/api/identity/%69nterno/usuarios/x',
  '/api/identity//interno/usuarios/x',
  '/api/identity/./interno/usuarios/x',
  '/api/viajes/Metrics',
  '/api/otro/health',
];
for (const ruta of internas) {
  const res = await fetch(`${BASE}${ruta}`, { headers: { 'X-Token-Servicio': 'cualquiera' } });
  const cuerpo = await res.json().catch(() => null);
  revisar(`${ruta} → 404`, res.status === 404 && cuerpo?.error?.code === 'RUTA_NO_ENCONTRADA', String(res.status));
}

// Un cuerpo de más de 32 kB lo corta nginx: con el formato de error de los servicios, no su página HTML.
{
  const res = await fetch(`${BASE}/api/identity/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relleno: 'x'.repeat(40_000) }),
  });
  const cuerpo = await res.json().catch(() => null);
  revisar('cuerpo de 40 kB → 413 en JSON', res.status === 413 && cuerpo?.error?.code === 'CUERPO_DEMASIADO_GRANDE', String(res.status));
}

// --- SSE sin buffer ----------------------------------------------------------------------------
if (!env.IDENTITY_SEED_CONTRASENA) {
  revisar('SSE: falta IDENTITY_SEED_CONTRASENA en el .env', false);
} else {
  const login = await fetch(`${BASE}/api/identity/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pasajero@viajes.test', contrasena: env.IDENTITY_SEED_CONTRASENA }),
  });
  revisar('login del pasajero del seed', login.status === 200, String(login.status));
  if (login.status === 200) {
    const { token } = await login.json();
    const inicio = Date.now();
    const control = new AbortController();
    const sse = await fetch(`${BASE}/api/viajes/eventos`, { headers: { Authorization: `Bearer ${token}` }, signal: control.signal });
    revisar('GET /api/viajes/eventos → 200 text/event-stream', sse.status === 200 && sse.headers.get('content-type')?.startsWith('text/event-stream'));
    // Las primeras líneas son 13 bytes: con buffer, nginx las retendría hasta juntar más.
    const lector = sse.body.getReader();
    const primero = await Promise.race([lector.read(), new Promise((r) => setTimeout(() => r(null), 2000))]);
    const texto = primero?.value ? new TextDecoder().decode(primero.value) : '';
    revisar('el primer pedazo del stream llega enseguida (sin buffer)', texto.startsWith('retry:') && Date.now() - inicio < 2000, `${Date.now() - inicio} ms`);
    control.abort();
  }
}

console.log(fallas === 0 ? '\nTodo bien.' : `\n${fallas} falla(s).`);
process.exit(fallas === 0 ? 0 : 1);
