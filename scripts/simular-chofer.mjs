// npm run demo:chofer -- [url] [opciones]: un chofer automático para la demo. Vos hacés de pasajero en
// el navegador y ves en el mapa cómo el auto viene a buscarte y te lleva, por las calles.
//
//   node scripts/simular-chofer.mjs [url] [--env archivo] [--chofer email] [--desde lat,lng]
//                                         [--kmh 40] [--sin-calles]
//
// - url: por defecto http://localhost:<WEB_PUERTO o 8080>. Contra el publicado, su https://…
// - Entra como el chofer del seed (o --chofer), se pone disponible y queda en --desde (por defecto a
//   1,5 km de la Plaza 25 de Mayo, dentro de la zona «Resistencia» de `npm run demo:flotas`).
// - Acepta la primera oferta que le llega. Toca «Voy en camino», maneja hasta el origen, «Inició el
//   viaje», maneja hasta el destino y «Finalizar». Después espera el próximo viaje, desde donde quedó.
// - Maneja por las calles con la ruta de OSRM (router.project-osrm.org, el ruteo público sobre
//   OpenStreetMap); si no responde, o con --sin-calles, en línea recta. Informa su posición cada 1 s,
//   como un GPS: el pasajero lo ve moverse en vivo (SSE DriverLocationUpdated) y la tarifa final sale
//   del recorrido real.
// - Si el pasajero cancela, vuelve a esperar. Si se corta, al volver a correrlo retoma el viaje activo
//   desde la última posición (la guarda en un archivo temporal); sin ella, desde el origen si el viaje
//   ya estaba en curso.
// - Ctrl+C: deja de estar disponible y termina.
//
// Contraseña: IDENTITY_SEED_CONTRASENA del archivo de --env (por ejemplo deploy/.env.coolify), del
// entorno, o del .env. No imprime contraseñas ni tokens. Mientras corre, la pantalla del chofer en el
// navegador tiene que estar cerrada: si no, los dos mandan posiciones distintas.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { leerEnv } from './lib/entorno.mjs';

// OSRM está en Europa: desde Argentina, conectar tarda más que los 250 ms que Node le da a cada
// dirección (IPv6 e IPv4) antes de pasar a la siguiente, y fetch fallaba con ETIMEDOUT.
setDefaultAutoSelectFamilyAttemptTimeout(2000);

const { values: op, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: 'string' },
    chofer: { type: 'string', default: 'chofer@viajes.test' },
    desde: { type: 'string', default: '-27.4620,-58.9960' },
    kmh: { type: 'string', default: '40' },
    'sin-calles': { type: 'boolean', default: false },
  },
});

const envLocal = leerEnv();
const contrasena = (op.env && leerEnv(op.env).IDENTITY_SEED_CONTRASENA) || process.env.IDENTITY_SEED_CONTRASENA || envLocal.IDENTITY_SEED_CONTRASENA;
if (!contrasena) {
  console.error('Falta IDENTITY_SEED_CONTRASENA: en el entorno, en el .env o con --env <archivo>.');
  process.exit(1);
}
const API = `${(positionals[0] ?? `http://localhost:${envLocal.WEB_PUERTO || 8080}`).replace(/\/$/, '')}/api`;
const METROS_POR_SEGUNDO = Number(op.kmh) / 3.6;
if (!(METROS_POR_SEGUNDO > 0)) {
  console.error('--kmh tiene que ser un número mayor que 0.');
  process.exit(1);
}
const [latDesde, lngDesde] = op.desde.split(',').map(Number);
if (!Number.isFinite(latDesde) || !Number.isFinite(lngDesde)) {
  console.error('--desde tiene que ser lat,lng (por ejemplo -27.4620,-58.9960).');
  process.exit(1);
}

const hora = () => new Date().toLocaleTimeString('es-AR', { hour12: false });
const log = (texto) => console.log(`${hora()}  ${texto}`);
const km = (metros) => `${(metros / 1000).toFixed(1).replace('.', ',')} km`;
const corto = (id) => id.slice(0, 8);

// --- La API ------------------------------------------------------------------------------------

let token = null;
let terminando = false;

async function entrar() {
  const r = await fetch(`${API}/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: op.chofer, contrasena }),
  });
  if (!r.ok) throw new Error(`no pude entrar como ${op.chofer} (${r.status}). ¿La contraseña es la del entorno?`);
  token = (await r.json()).token;
}

/**
 * Un pedido a la API (`ruta` después de /api). Con token vencido (15 min), vuelve a entrar una vez.
 * Los que cambian algo llevan Idempotency-Key, la misma en cada reintento: un corte de red no duplica.
 */
async function api(metodo, ruta, cuerpo) {
  const clave = metodo === 'GET' ? null : randomUUID();
  let reentro = false;
  for (let intento = 1; ; intento++) {
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (cuerpo !== undefined) headers['content-type'] = 'application/json';
    if (clave) headers['idempotency-key'] = clave;
    let r;
    try {
      r = await fetch(`${API}${ruta}`, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
    } catch (err) {
      if (intento >= 4) throw err;
      await esperar(1000);
      continue;
    }
    if (r.status === 401 && !reentro) {
      reentro = true;
      await entrar();
      continue;
    }
    const json = await r.json().catch(() => null);
    const codigo = json?.error?.code;
    if ((codigo === 'CLAVE_IDEMPOTENCIA_EN_CURSO' || r.status >= 502) && intento < 4) {
      await esperar(1000);
      continue;
    }
    return { estado: r.status, json, codigo };
  }
}

const estadoChofer = async () => {
  const r = await api('GET', '/viajes/chofer/estado');
  if (r.estado !== 200) throw new Error(`GET /chofer/estado: ${r.estado} ${r.codigo ?? ''}`);
  return r.json;
};

// --- Posición: un GPS que informa cada 1 s -----------------------------------------------------

let posicion = { lat: latDesde, lng: lngDesde };
let ultimoErrorPing = null;
/** El viaje que se está haciendo, o null: la posición guardada solo sirve para retomar ese viaje. */
let viajeActual = null;

// La última posición, en un archivo temporal por chofer: si el script se corta en medio de un viaje,
// al volver a correrlo sigue desde ahí, en vez de saltar a --desde y rehacer el camino.
const RUTA_POSICION = join(tmpdir(), `simular-chofer-${op.chofer.replace(/[^a-z0-9]/gi, '_')}.json`);

function guardarPosicion() {
  try {
    writeFileSync(RUTA_POSICION, JSON.stringify({ solicitudId: viajeActual, ...posicion }));
  } catch {
    // sin el archivo, un corte retoma desde el origen o --desde: no vale la pena frenar el GPS
  }
}

/** Dónde arranca si al entrar ya tiene un viaje activo. */
function posicionParaRetomar(viaje) {
  try {
    const guardada = JSON.parse(readFileSync(RUTA_POSICION, 'utf8'));
    if (guardada.solicitudId === viaje.id && Number.isFinite(guardada.lat) && Number.isFinite(guardada.lng)) {
      return { posicion: { lat: guardada.lat, lng: guardada.lng }, desde: 'la última posición guardada' };
    }
  } catch {
    // no hay posición guardada de este viaje
  }
  // En curso, el pasajero ya subió: lo más cercano a la verdad es el origen, no --desde.
  if (viaje.estado === 'EN_CURSO') return { posicion: { ...viaje.origen }, desde: 'el origen del viaje' };
  return { posicion, desde: '--desde' };
}

async function gps() {
  while (!terminando) {
    const inicio = Date.now();
    guardarPosicion();
    try {
      const r = await api('POST', '/ubicacion/ubicaciones', posicion);
      const error = r.estado === 204 ? null : `${r.estado} ${r.codigo ?? ''}`.trim();
      if (error && error !== ultimoErrorPing) log(`la posición no se pudo informar: ${error}`);
      ultimoErrorPing = error;
    } catch (err) {
      if (ultimoErrorPing !== 'red') log(`la posición no se pudo informar: ${err.message}`);
      ultimoErrorPing = 'red';
    }
    await esperar(Math.max(0, 1000 - (Date.now() - inicio)));
  }
}

// --- Rutas y manejo ----------------------------------------------------------------------------

const RADIO_TIERRA = 6_371_000;
const rad = (g) => (g * Math.PI) / 180;
function distancia(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA * Math.asin(Math.sqrt(h));
}

/** Los puntos del camino de `a` a `b`: por las calles (OSRM) o, si no se puede, en línea recta. */
async function ruta(a, b) {
  if (!op['sin-calles']) {
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
      const r = await fetch(url, { headers: { 'user-agent': 'simulador-chofer-demo/1.0' }, signal: AbortSignal.timeout(5000) });
      const json = await r.json();
      const coords = json?.routes?.[0]?.geometry?.coordinates;
      if (r.ok && Array.isArray(coords) && coords.length >= 2) return { puntos: [a, ...coords.map(([lng, lat]) => ({ lat, lng })), b], calles: true };
    } catch {
      // sin ruteo: en línea recta
    }
  }
  return { puntos: [a, b], calles: false };
}

/**
 * Maneja hasta `destino` moviendo `posicion` a la velocidad de --kmh (el GPS la informa cada 1 s).
 * Cada 3 s confirma que el viaje sigue siendo suyo: si el pasajero canceló, para y devuelve false.
 */
async function manejar(destino, solicitudId, que) {
  const { puntos, calles } = await ruta(posicion, destino);
  const tramos = puntos.slice(1).map((p, i) => ({ desde: puntos[i], hasta: p, metros: distancia(puntos[i], p) }));
  const total = tramos.reduce((s, t) => s + t.metros, 0);
  log(`${que}: ${km(total)} ${calles ? 'por las calles' : 'en línea recta'}, unos ${Math.max(1, Math.round(total / METROS_POR_SEGUNDO / 60))} min a ${op.kmh} km/h`);

  // Cada segundo avanza METROS_POR_SEGUNDO sobre el camino, aunque eso cruce varios tramos (las rutas
  // de OSRM tienen muchos de pocos metros): la velocidad es la de --kmh, no un tramo por segundo.
  let hecho = 0;
  let tramo = 0;
  let antesDelTramo = 0;
  let ultimoControl = Date.now();
  let ultimoAviso = 0;
  while (hecho < total) {
    if (terminando) return false;
    await esperar(1000);
    hecho = Math.min(total, hecho + METROS_POR_SEGUNDO);
    while (tramo < tramos.length - 1 && antesDelTramo + tramos[tramo].metros < hecho) antesDelTramo += tramos[tramo++].metros;
    const t = tramos[tramo];
    const f = t.metros === 0 ? 1 : Math.min(1, (hecho - antesDelTramo) / t.metros);
    posicion = { lat: t.desde.lat + (t.hasta.lat - t.desde.lat) * f, lng: t.desde.lng + (t.hasta.lng - t.desde.lng) * f };
    const cuarto = Math.floor((hecho / total) * 4);
    if (cuarto > ultimoAviso && cuarto < 4) {
      ultimoAviso = cuarto;
      log(`  ${cuarto * 25} % (faltan ${km(total - hecho)})`);
    }
    if (Date.now() - ultimoControl >= 3000) {
      ultimoControl = Date.now();
      const estado = await estadoChofer().catch(() => null); // un corte de red no corta el viaje
      if (estado && estado.viaje?.id !== solicitudId) {
        log('  el viaje se canceló: vuelvo a esperar ofertas');
        return false;
      }
    }
  }
  posicion = { ...destino };
  return true;
}

const ACCIONES = { 'en-camino': 'Voy en camino', iniciar: 'Inició el viaje', finalizar: 'Finalizar' };

async function avanzar(viaje, accion) {
  const r = await api('POST', `/viajes/solicitudes/${viaje.id}/${accion}`, {});
  if (r.estado !== 200) {
    log(`«${ACCIONES[accion]}» no se pudo: ${r.estado} ${r.codigo ?? ''} (¿se canceló?)`);
    return null;
  }
  log(`«${ACCIONES[accion]}»`);
  return r.json;
}

/** Lleva un viaje desde el estado en que esté hasta el final. */
async function hacerViaje(inicial) {
  viajeActual = inicial.id;
  try {
    await llevarViaje(inicial);
  } finally {
    viajeActual = null;
  }
}

async function llevarViaje(inicial) {
  let viaje = inicial;
  log(`viaje ${corto(viaje.id)} (${viaje.estado})`);
  if (viaje.estado === 'ASIGNADO') viaje = await avanzar(viaje, 'en-camino');
  if (viaje?.estado === 'EN_CAMINO') {
    if (!(await manejar(viaje.origen, viaje.id, 'hacia el origen'))) return;
    log('llegué al origen');
    viaje = await avanzar(viaje, 'iniciar');
  }
  if (viaje?.estado === 'EN_CURSO') {
    if (!(await manejar(viaje.destino, viaje.id, 'hacia el destino'))) return;
    log('llegué al destino');
    viaje = await avanzar(viaje, 'finalizar');
    if (viaje) log(`viaje ${corto(viaje.id)} terminado. Espero el próximo, desde acá.`);
  }
}

// --- Principal ---------------------------------------------------------------------------------

process.on('SIGINT', async () => {
  if (terminando) process.exit(1);
  terminando = true;
  log('termino: dejo de estar disponible');
  const r = await api('PUT', '/viajes/chofer/disponibilidad', { disponible: false }).catch(() => null);
  if (r && r.estado !== 200) log(`  no pude: ${r.estado} ${r.codigo ?? ''} (con un viaje activo, queda como está; volvé a correrlo para terminarlo)`);
  process.exit(0);
});

try {
  await entrar();
  const inicial = await estadoChofer();
  if (!inicial.registro) throw new Error(`${op.chofer} no está en ninguna flota: correr antes node scripts/demo-flotas.mjs <url>`);
  if (!inicial.registro.habilitado || !inicial.registro.activo) throw new Error(`${op.chofer} no está habilitado o activo en su flota (node scripts/demo-flotas.mjs <url>)`);
  if (inicial.viaje) {
    // Antes de arrancar el GPS: si no, el primer ping mandaría --desde y el auto saltaría para atrás.
    const retomar = posicionParaRetomar(inicial.viaje);
    posicion = retomar.posicion;
    log(`hay un viaje activo (${inicial.viaje.estado}): lo retomo desde ${retomar.desde}`);
  }

  void gps();
  await esperar(1500); // que location tenga la posición antes de que lo busquen
  if (!inicial.registro.disponible) {
    const r = await api('PUT', '/viajes/chofer/disponibilidad', { disponible: true });
    if (r.estado !== 200) throw new Error(`no pude ponerme disponible: ${r.estado} ${r.codigo ?? ''}`);
  }
  const enQue = inicial.viaje ? 'Sigo con el viaje' : 'Esperando ofertas';
  log(`${op.chofer} disponible en ${posicion.lat.toFixed(4)}, ${posicion.lng.toFixed(4)}. ${enQue} (Ctrl+C para terminar)…`);

  for (;;) {
    try {
      const { viaje, ofertas } = await estadoChofer();
      if (viaje) {
        await hacerViaje(viaje);
        continue;
      }
      const oferta = ofertas[0];
      if (!oferta) {
        await esperar(1000);
        continue;
      }
      log(`oferta ${corto(oferta.ofertaId)}: ${km(distancia(posicion, oferta.origen))} hasta el origen; la acepto`);
      const r = await api('POST', `/viajes/ofertas/${oferta.ofertaId}/aceptar`, {});
      if (r.estado === 200) await hacerViaje(r.json);
      else log(`  no se pudo aceptar: ${r.estado} ${r.codigo ?? ''}`);
    } catch (err) {
      // Un corte de red o un reinicio del servidor: se reintenta, y el viaje activo se retoma solo.
      log(`error: ${err instanceof Error ? err.message : String(err)}; reintento en 3 s`);
      await esperar(3000);
    }
  }
} catch (err) {
  console.error(`simular-chofer: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
