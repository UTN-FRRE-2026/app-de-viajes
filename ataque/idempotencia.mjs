#!/usr/bin/env node
// Prueba la Idempotency-Key de una ruta con efecto, en cuatro fases:
//   serie        la misma clave dos veces, una después de la otra
//   paralelo     la misma clave N veces a la vez
//   otro-cuerpo  la clave de «serie» con otro cuerpo
//   sin-clave    el pedido sin el encabezado (crea un efecto: va solo si se pide)
// y resume si hubo un solo efecto. Node 22, sin dependencias. Ver ataque/README.md y docs/ataque.md.

import {
  campo,
  enviar,
  esExito,
  guardarSalida,
  imprimirResumen,
  leerCuerpo,
  leerOpciones,
  normalizar,
  nuevaClave,
  reemplazar,
  salirConError,
} from './comun.mjs';

const AYUDA = `Uso: node ataque/idempotencia.mjs --url <base> --ruta <ruta> --cuerpo <json> --token <t> [opciones]
     node ataque/idempotencia.mjs --config idem.json [opciones que pisan el JSON]

  -u, --url URL             base de la API (o ATAQUE_URL)
  -m, --metodo M            POST por defecto
  -r, --ruta R              la ruta con efecto
  -b, --cuerpo JSON         cuerpo JSON, o @archivo.json. {fase} cambia en cada fase (un email nuevo);
                            {corrida} es el mismo en toda la corrida
      --cuerpo-alt JSON     otro cuerpo válido para la fase otro-cuerpo (sin él, se saltea)
  -t, --token T             token del usuario (o ATAQUE_TOKEN)
  -H, --encabezado "K: V"   encabezado extra (se repite)
      --clave-encabezado K  Idempotency-Key por defecto
  -n, --n N                 pedidos simultáneos en la fase paralelo (10)
      --fases a,b           serie,paralelo,otro-cuerpo por defecto; se puede sumar sin-clave
      --campo-id RUTA       campo que identifica el efecto en la respuesta (id; ej.: version, data.id)
      --contar-ruta R       GET que cuenta los efectos (ej.: un listado), antes y después de cada fase
      --contar-campo RUTA   dónde está la cuenta en esa respuesta (una lista o un número; sin él, la raíz)
      --pausa MS            espera entre fases (500)
      --timeout MS          15000
      --ignorar a,b         campos que no cuentan al comparar cuerpos (requestId,request_id,timestamp,traceId)
  -o, --salida ARCHIVO      guarda pedidos y respuestas (sin tokens) como evidencia
  -h, --ayuda

Sale con código 2 si alguna fase da FALLA.`;

const o = leerOpciones(
  {
    'cuerpo-alt': { type: 'string' },
    n: { type: 'string', short: 'n' },
    fases: { type: 'string' },
    'campo-id': { type: 'string' },
    'contar-ruta': { type: 'string' },
    'contar-campo': { type: 'string' },
    pausa: { type: 'string' },
  },
  AYUDA,
);

if (!o.ruta) salirConError(`Falta --ruta.\n\n${AYUDA}`);
if (typeof o['cuerpo-alt'] === 'string') o['cuerpo-alt'] = leerCuerpo(o['cuerpo-alt']);
const n = Number(o.n ?? 10);
if (!Number.isInteger(n) || n < 2 || n > 200) salirConError('--n tiene que estar entre 2 y 200');
const fases = (Array.isArray(o.fases) ? o.fases : String(o.fases ?? 'serie,paralelo,otro-cuerpo').split(',')).map((f) => f.trim());
const pausa = Number(o.pausa ?? 500);
const token = o.tokens[0];

// `{fase}`: un valor nuevo en cada fase y el mismo dentro de ella. Sirve para recursos con unicidad
// natural (un email): cada fase arranca con uno sin usar. otro-cuerpo usa el de serie.
const valoresFase = {};
function deFase(valor, fase) {
  if (valor === undefined) return undefined;
  valoresFase[fase] ??= nuevaClave().slice(0, 8);
  return JSON.parse(JSON.stringify(valor).replaceAll('{fase}', valoresFase[fase]));
}

/** El pedido de una fase. Se arma una vez por fase: con la misma clave va exactamente el mismo cuerpo. */
const pedidoDe = (fase, cuerpo = o.cuerpo) => ({
  metodo: o.metodo,
  ruta: reemplazar(deFase(o.ruta, fase), 0),
  cuerpo: reemplazar(deFase(cuerpo, fase), 0),
  token,
});

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lo que identifica el efecto: el campo pedido, o `id`, o el cuerpo entero normalizado. */
function efecto(r) {
  const id = campo(r.json, o['campo-id'] ?? 'id');
  return id !== undefined ? JSON.stringify(id) : normalizar(r, o.ignorar);
}

async function contar() {
  if (!o['contar-ruta']) return null;
  const r = await enviar(o, { metodo: 'GET', ruta: o['contar-ruta'], token });
  if (!esExito(r)) return null;
  const v = o['contar-campo'] ? campo(r.json, o['contar-campo']) : r.json;
  return Array.isArray(v) ? v.length : typeof v === 'number' ? v : null;
}

/** Corre una fase con la cuenta de efectos antes y después, si hay --contar-ruta. */
async function conCuenta(fn) {
  const antes = await contar();
  const resultado = await fn();
  const despues = await contar();
  const delta = antes === null || despues === null ? null : despues - antes;
  if (delta !== null) console.log(`  efectos según ${o['contar-ruta']}: ${antes} → ${despues} (${delta >= 0 ? '+' : ''}${delta})`);
  return { ...resultado, delta };
}

const veredictos = [];
const evidencia = {};
function veredicto(fase, nivel, texto) {
  veredictos.push({ fase, nivel, texto });
  console.log(`  ${nivel}: ${texto}`);
}

let claveSerie = null;
let primeraSerie = null;

if (fases.includes('serie')) {
  claveSerie = nuevaClave();
  console.log(`\n== serie: la misma clave dos veces, una después de la otra (${claveSerie})`);
  const p = pedidoDe('serie');
  const { a, b, delta } = await conCuenta(async () => {
    const a = await enviar(o, { ...p, clave: claveSerie });
    const b = await enviar(o, { ...p, clave: claveSerie });
    return { a, b };
  });
  primeraSerie = a;
  evidencia.serie = { pedido: p, clave: claveSerie, respuestas: [a, b] };
  imprimirResumen('respuestas', [a, b], o.ignorar);
  console.log(`  encabezados del reintento: ${JSON.stringify(b.encabezados)}`);
  if (!esExito(a)) {
    veredicto('serie', 'INCONCLUSO', `el primer pedido ya falló (${a.estado}): revisá ruta, cuerpo y token`);
  } else if (delta !== null && delta > 1) {
    veredicto('serie', 'FALLA', `dos pedidos con la misma clave dejaron ${delta} efectos`);
  } else if (esExito(b) && efecto(a) !== efecto(b)) {
    veredicto('serie', 'FALLA', 'el reintento devolvió otro efecto (otro id o cuerpo): la clave no deduplica');
  } else if (esExito(b)) {
    const identico = a.texto === b.texto;
    veredicto('serie', 'OK', `el reintento repite la respuesta${identico ? ' byte a byte' : ' (con diferencias fuera del id)'}`);
  } else {
    veredicto(
      'serie',
      'OBSERVACIÓN',
      `el reintento recibió ${b.estado} en lugar de la respuesta original: no hay doble efecto, pero el cliente no sabe si su pedido funcionó`,
    );
  }
  await dormir(pausa);
}

if (fases.includes('paralelo')) {
  const clave = nuevaClave();
  console.log(`\n== paralelo: la misma clave ${n} veces a la vez (${clave})`);
  const p = pedidoDe('paralelo');
  const { respuestas, delta } = await conCuenta(async () => ({
    respuestas: await Promise.all(Array.from({ length: n }, () => enviar(o, { ...p, clave }))),
  }));
  evidencia.paralelo = { pedido: p, clave, respuestas };
  imprimirResumen('respuestas', respuestas, o.ignorar);
  const efectos = new Set(respuestas.filter(esExito).map(efecto));
  if (delta !== null && delta > 1) {
    veredicto('paralelo', 'FALLA', `${n} pedidos con la misma clave dejaron ${delta} efectos`);
  } else if (efectos.size > 1) {
    veredicto('paralelo', 'FALLA', `${efectos.size} efectos distintos entre las respuestas 2xx con la misma clave`);
  } else if (efectos.size === 0) {
    veredicto('paralelo', 'INCONCLUSO', 'ninguna respuesta 2xx');
  } else {
    veredicto('paralelo', 'OK', 'un solo efecto; el resto repitió la respuesta o recibió un error de «en curso»');
  }
  if (respuestas.some((r) => r.estado >= 500 || r.estado === 0)) {
    veredicto('paralelo', 'OBSERVACIÓN', 'hubo 5xx o errores de red con la misma clave: probable choque de unicidad sin capturar');
  }
  await dormir(pausa);
}

if (fases.includes('otro-cuerpo')) {
  if (o['cuerpo-alt'] === undefined) {
    console.log('\n== otro-cuerpo: salteada (falta --cuerpo-alt)');
  } else {
    // Con la clave de serie y su {fase}: mismo recurso, otro cuerpo.
    const faseRef = claveSerie ? 'serie' : 'otro-cuerpo';
    let clave = claveSerie;
    let original = primeraSerie;
    if (!clave) {
      clave = nuevaClave();
      original = await enviar(o, { ...pedidoDe(faseRef), clave });
    }
    console.log(`\n== otro-cuerpo: la clave ${clave} con otro cuerpo`);
    const p = pedidoDe(faseRef, o['cuerpo-alt']);
    const { r, delta } = await conCuenta(async () => ({ r: await enviar(o, { ...p, clave }) }));
    evidencia.otroCuerpo = { pedido: p, clave, original, respuesta: r };
    imprimirResumen('respuesta', [r], o.ignorar);
    if (!esExito(original)) {
      veredicto('otro-cuerpo', 'INCONCLUSO', `el pedido original falló (${original.estado})`);
    } else if (delta !== null && delta > 0) {
      veredicto('otro-cuerpo', 'FALLA', 'la misma clave con otro cuerpo se procesó como un pedido nuevo');
    } else if (esExito(r) && efecto(r) !== efecto(original)) {
      veredicto('otro-cuerpo', 'FALLA', 'la misma clave con otro cuerpo devolvió otro efecto: la clave no está atada al pedido');
    } else if (esExito(r)) {
      veredicto(
        'otro-cuerpo',
        'OBSERVACIÓN',
        'devolvió la respuesta guardada sin comparar el cuerpo: un cliente con un error recibe una respuesta que no es de su pedido (lo esperado es 422)',
      );
    } else {
      veredicto('otro-cuerpo', 'OK', `rechazado con ${r.estado}`);
    }
  }
  await dormir(pausa);
}

if (fases.includes('sin-clave')) {
  console.log('\n== sin-clave: el pedido sin el encabezado');
  const p = pedidoDe('sin-clave');
  const { r } = await conCuenta(async () => ({ r: await enviar(o, { ...p, clave: null }) }));
  evidencia.sinClave = { pedido: p, respuesta: r };
  imprimirResumen('respuesta', [r], o.ignorar);
  if (esExito(r)) veredicto('sin-clave', 'OBSERVACIÓN', 'la clave no es obligatoria: un cliente que no la manda queda sin protección');
  else veredicto('sin-clave', 'OK', `rechazado con ${r.estado}`);
}

console.log('\n== resumen');
for (const v of veredictos) console.log(`  ${v.fase.padEnd(12)} ${v.nivel}: ${v.texto}`);
guardarSalida(o, {
  pedido: { metodo: o.metodo, ruta: o.ruta, cuerpo: o.cuerpo, cuerpoAlt: o['cuerpo-alt'] },
  veredictos,
  evidencia: JSON.parse(JSON.stringify(evidencia, (k, v) => (k === 'json' ? undefined : v))),
});
process.exit(veredictos.some((v) => v.nivel === 'FALLA') ? 2 : 0);
