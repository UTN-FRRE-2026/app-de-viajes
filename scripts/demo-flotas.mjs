// npm run demo:flotas: deja la demo de flotas y zonas armada contra el sistema en contenedores, por la
// API (como lo haría un admin). Se puede correr las veces que haga falta: cada paso es idempotente.
//
//   node scripts/demo-flotas.mjs [url]   (por defecto http://localhost:<WEB_PUERTO o 8080>)
//
// - Zonas «Resistencia» (Gran Resistencia: Resistencia, Barranqueras, Fontana y Puerto Vilelas) y
//   «Corrientes» (la ciudad, del otro lado del río). No se superponen.
// - La flota del admin.flota (Flota Demo) opera en Resistencia; la del admin.flota2 (Flota Corrientes),
//   en Corrientes. Si una flota no existe, se crea con límite 5; si existe, no se toca su límite (y su
//   nombre solo si cambió acá).
// - El chofer del seed queda en la Flota Demo, habilitado y activo (ponerse disponible es cosa suya,
//   desde /chofer).
// Usa las cuentas del seed (`npm run seed`) con IDENTITY_SEED_CONTRASENA del .env. No imprime
// contraseñas ni tokens.
import { randomUUID } from 'node:crypto';
import { leerEnv } from './lib/entorno.mjs';

const env = { ...leerEnv(), ...process.env };
const BASE = `${(process.argv[2] ?? `http://localhost:${env.WEB_PUERTO || 8080}`).replace(/\/$/, '')}/api`;
const CONTRASENA = env.IDENTITY_SEED_CONTRASENA;
if (!CONTRASENA) {
  console.error('Falta IDENTITY_SEED_CONTRASENA en el .env (la contraseña de los usuarios del seed).');
  process.exit(1);
}

/**
 * Ids fijos: la demo se puede rearmar sin duplicar zonas (con un id que ya existe, se reemplazan su
 * nombre y su área). Las cajas salen de los límites de OpenStreetMap; entre las dos queda el río Paraná.
 */
const ZONAS = [
  { id: '00000000-0000-4000-8000-0000000ca8a0', nombre: 'Resistencia', caja: [-59.08, -27.55, -58.87, -27.38] },
  { id: '00000000-0000-4000-8000-0000000a07e0', nombre: 'Corrientes', caja: [-58.86, -27.55, -58.7, -27.41] },
];
const poligono = ([lng1, lat1, lng2, lat2]) => ({
  type: 'Polygon',
  coordinates: [[[lng1, lat1], [lng2, lat1], [lng2, lat2], [lng1, lat2], [lng1, lat1]]],
});

async function entrar(email) {
  const r = await fetch(`${BASE}/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, contrasena: CONTRASENA }),
  });
  if (!r.ok) throw new Error(`no pude entrar como ${email} (${r.status}). ¿Corriste npm run seed?`);
  const s = await r.json();
  return { token: s.token, usuario: s.usuario };
}

async function api(sesion, metodo, ruta, cuerpo) {
  const headers = { authorization: `Bearer ${sesion.token}`, accept: 'application/json' };
  if (cuerpo !== undefined) headers['content-type'] = 'application/json';
  if (metodo !== 'GET') headers['idempotency-key'] = randomUUID();
  const r = await fetch(`${BASE}/viajes${ruta}`, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const json = await r.json().catch(() => null);
  return { estado: r.status, json, codigo: json?.error?.code };
}

function exigir(r, esperado, que) {
  if (r.estado !== esperado) throw new Error(`${que}: ${r.estado}${r.codigo ? ` ${r.codigo}` : ''}`);
  return r.json;
}

try {
  const admin = await entrar('admin@viajes.test');
  const flotaA = await entrar('admin.flota@viajes.test');
  const flotaB = await entrar('admin.flota2@viajes.test');
  const chofer = await entrar('chofer@viajes.test');

  for (const [sesion, nombre] of [
    [flotaA, 'Flota Demo'],
    [flotaB, 'Flota Corrientes'],
  ]) {
    const actual = await api(sesion, 'GET', '/flota');
    if (actual.estado === 404) exigir(await api(admin, 'PUT', `/admin/flotas/${sesion.usuario.fleetId}`, { nombre, maxActivos: 5 }), 200, `crear ${nombre}`);
    else if (exigir(actual, 200, `leer ${nombre}`).nombre !== nombre) {
      // Una demo armada antes (la Flota Norte de la zona de CABA): se renombra y conserva su límite.
      const { maxActivos } = actual.json;
      exigir(await api(admin, 'PUT', `/admin/flotas/${sesion.usuario.fleetId}`, { nombre, maxActivos }), 200, `renombrar ${nombre}`);
    }
  }

  for (const z of ZONAS) exigir(await api(admin, 'PUT', `/admin/zonas/${z.id}`, { nombre: z.nombre, area: poligono(z.caja) }), 200, `zona ${z.nombre}`);
  exigir(await api(admin, 'PUT', `/admin/flotas/${flotaA.usuario.fleetId}/zonas`, { zonas: [ZONAS[0].id] }), 200, 'zonas de la Flota Demo');
  exigir(await api(admin, 'PUT', `/admin/flotas/${flotaB.usuario.fleetId}/zonas`, { zonas: [ZONAS[1].id] }), 200, 'zonas de la Flota Corrientes');

  const choferId = chofer.usuario.id;
  let registro = await api(flotaA, 'GET', `/flota/choferes/${choferId}`);
  if (registro.estado === 404) {
    const alta = await api(flotaA, 'POST', '/flota/choferes', { choferId, vehiculo: { patente: 'AB123CD', marca: 'Toyota', modelo: 'Etios' } });
    if (alta.codigo === 'CHOFER_YA_REGISTRADO') throw new Error('el chofer del seed ya está en otra flota: la demo lo espera en la Flota Demo');
    registro = { estado: 200, json: exigir(alta, 201, 'alta del chofer del seed') };
  }
  if (!exigir(registro, 200, 'chofer del seed').habilitado) exigir(await api(admin, 'POST', `/admin/choferes/${choferId}/habilitar`, {}), 200, 'habilitar');
  const activo = await api(flotaA, 'POST', `/flota/choferes/${choferId}/activar`, {});
  if (activo.codigo === 'LIMITE_FLOTA_ALCANZADO') throw new Error('la Flota Demo está en su límite: desactivá a otro chofer desde /flota');
  exigir(activo, 200, 'activar');

  const resumen = async (sesion) => {
    const f = exigir(await api(sesion, 'GET', '/flota'), 200, 'flota');
    return `${f.nombre}: ${f.activos} de ${f.maxActivos} activos`;
  };
  console.log('Demo de flotas y zonas lista:');
  console.log(`  zonas: ${ZONAS.map((z) => z.nombre).join(' y ')}`);
  console.log(`  ${await resumen(flotaA)}, opera en Resistencia; el chofer del seed está habilitado y activo`);
  console.log(`  ${await resumen(flotaB)}, opera en Corrientes`);
  console.log('  Para recibir ofertas, el chofer se pone disponible en /chofer, con su ubicación en Gran Resistencia.');
} catch (err) {
  console.error(`demo-flotas: ${err.message}`);
  process.exit(1);
}
