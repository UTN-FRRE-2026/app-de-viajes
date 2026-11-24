// Lo que comparten carrera.mjs e idempotencia.mjs: opciones, configuración, pedidos y resúmenes.
// Solo Node 22: fetch, AbortSignal.timeout, node:util parseArgs y node:crypto. Sin dependencias.

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

/** Opciones comunes de los dos scripts. Cada script agrega las suyas. */
export const OPCIONES_COMUNES = {
  config: { type: 'string', short: 'c' },
  url: { type: 'string', short: 'u' },
  metodo: { type: 'string', short: 'm' },
  ruta: { type: 'string', short: 'r' },
  cuerpo: { type: 'string', short: 'b' },
  token: { type: 'string', short: 't', multiple: true },
  tokens: { type: 'string' },
  encabezado: { type: 'string', short: 'H', multiple: true },
  'clave-encabezado': { type: 'string' },
  timeout: { type: 'string' },
  ignorar: { type: 'string' },
  salida: { type: 'string', short: 'o' },
  ayuda: { type: 'boolean', short: 'h' },
};

/**
 * Lee la línea de comandos y, si hay --config, el JSON. La línea de comandos pisa al JSON.
 * Las claves del JSON se escriben igual que las opciones (`clave-encabezado`, `max-exitos`...),
 * salvo `cuerpo` (un objeto, no un texto), `tokens` (una lista), `encabezados` (un objeto) y `pedidos`.
 */
export function leerOpciones(propias, ayuda) {
  let args;
  try {
    args = parseArgs({ options: { ...OPCIONES_COMUNES, ...propias }, allowPositionals: false, strict: true }).values;
  } catch (err) {
    salirConError(`${err.message}\n\n${ayuda}`);
  }
  if (args.ayuda) {
    console.log(ayuda);
    process.exit(0);
  }
  const archivo = args.config ? leerJson(args.config) : {};
  const o = { ...archivo };
  for (const [k, v] of Object.entries(args)) if (v !== undefined && k !== 'config') o[k] = v;

  o.url = (o.url ?? process.env.ATAQUE_URL ?? '').replace(/\/+$/, '');
  if (!o.url) salirConError(`Falta --url (o ATAQUE_URL).\n\n${ayuda}`);
  o.metodo = (o.metodo ?? 'POST').toUpperCase();
  o.timeout = Number(o.timeout ?? 15000);
  o['clave-encabezado'] = o['clave-encabezado'] ?? 'Idempotency-Key';
  o.ignorar = new Set(
    (Array.isArray(o.ignorar) ? o.ignorar : String(o.ignorar ?? 'requestId,request_id,timestamp,traceId').split(','))
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (typeof o.cuerpo === 'string') o.cuerpo = leerCuerpo(o.cuerpo);
  o.tokens = juntarTokens(o);
  o.encabezados = juntarEncabezados(o);
  return o;
}

function juntarTokens(o) {
  const lista = [];
  if (Array.isArray(o.tokens)) lista.push(...o.tokens);
  else if (typeof o.tokens === 'string') lista.push(...leerLineas(o.tokens));
  if (Array.isArray(o.token)) lista.push(...o.token);
  else if (typeof o.token === 'string') lista.push(o.token);
  if (lista.length === 0 && process.env.ATAQUE_TOKEN) lista.push(process.env.ATAQUE_TOKEN);
  return lista.map((t) => t.trim()).filter(Boolean);
}

function juntarEncabezados(o) {
  const h = { ...(o.encabezados ?? {}) };
  for (const linea of o.encabezado ?? []) {
    const i = linea.indexOf(':');
    if (i <= 0) salirConError(`Encabezado mal formado: "${linea}" (se espera "Nombre: valor")`);
    h[linea.slice(0, i).trim()] = linea.slice(i + 1).trim();
  }
  return h;
}

/** `{"a":1}` o `@archivo.json`. */
export function leerCuerpo(texto) {
  if (texto === undefined || texto === null || texto === '') return undefined;
  const crudo = texto.startsWith('@') ? readFileSync(texto.slice(1), 'utf8') : texto;
  try {
    return JSON.parse(crudo);
  } catch {
    salirConError(`El cuerpo no es JSON válido: ${crudo.slice(0, 200)}`);
  }
}

function leerJson(ruta) {
  try {
    return JSON.parse(readFileSync(ruta, 'utf8'));
  } catch (err) {
    salirConError(`No se pudo leer ${ruta}: ${err.message}`);
  }
}

function leerLineas(ruta) {
  return readFileSync(ruta, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

export function salirConError(mensaje) {
  console.error(mensaje);
  process.exit(1);
}

/** El mismo en todos los pedidos de una corrida, distinto entre corridas (un email nuevo cada vez). */
export const CORRIDA = randomUUID().slice(0, 8);

/**
 * En la ruta y en los textos del cuerpo: `{i}` → el número de pedido, `{uuid}` → un UUID nuevo en
 * cada aparición, `{corrida}` → el mismo valor en toda la corrida. `{fase}` lo resuelve antes
 * idempotencia.mjs (uno por fase); si llega hasta acá, vale lo mismo que `{corrida}`.
 */
export function reemplazar(valor, i) {
  if (valor === undefined) return undefined;
  const texto = typeof valor === 'string' ? valor : JSON.stringify(valor);
  const r = texto
    .replaceAll('{i}', String(i))
    .replaceAll('{corrida}', CORRIDA)
    .replaceAll('{fase}', CORRIDA)
    .replace(/\{uuid\}/g, () => randomUUID());
  return typeof valor === 'string' ? r : JSON.parse(r);
}

const autorizacion = (token) => (/^\S+\s/.test(token) ? token : `Bearer ${token}`);

/**
 * Un pedido. Nunca tira: un error de red vuelve con estado 0.
 * `clave`: el valor del encabezado de idempotencia, o null para no mandarlo.
 */
export async function enviar(o, { metodo, ruta, cuerpo, token, clave, encabezados }) {
  const h = { accept: 'application/json', ...o.encabezados, ...(encabezados ?? {}) };
  if (token) h.authorization = autorizacion(token);
  if (cuerpo !== undefined) h['content-type'] = 'application/json';
  if (clave) h[o['clave-encabezado']] = clave;
  const inicio = performance.now();
  try {
    const r = await fetch(`${o.url}${ruta}`, {
      method: metodo,
      headers: h,
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(o.timeout),
      redirect: 'manual',
    });
    const texto = await r.text();
    return {
      estado: r.status,
      texto,
      json: intentarJson(texto),
      encabezados: encabezadosInteresantes(r.headers),
      ms: Math.round(performance.now() - inicio),
    };
  } catch (err) {
    const motivo = err?.cause?.code ?? err?.name ?? 'error';
    return { estado: 0, texto: `${motivo}: ${err.message}`, json: null, encabezados: {}, ms: Math.round(performance.now() - inicio) };
  }
}

function intentarJson(texto) {
  try {
    return texto ? JSON.parse(texto) : null;
  } catch {
    return null;
  }
}

/** Los que sirven de evidencia: idempotencia, reintentos y límites. */
function encabezadosInteresantes(headers) {
  const r = {};
  for (const [k, v] of headers) {
    if (/idempot|replay|retry-after|ratelimit|x-request-id/i.test(k)) r[k] = v;
  }
  return r;
}

/** El cuerpo sin los campos que cambian en cada pedido, con las claves ordenadas: sirve para agrupar. */
export function normalizar(respuesta, ignorar) {
  if (respuesta.json === null) return respuesta.texto.slice(0, 500);
  const limpiar = (v) => {
    if (Array.isArray(v)) return v.map(limpiar);
    if (v && typeof v === 'object') {
      const r = {};
      for (const k of Object.keys(v).sort()) if (!ignorar.has(k)) r[k] = limpiar(v[k]);
      return r;
    }
    return v;
  };
  return JSON.stringify(limpiar(respuesta.json));
}

/** `a.b.0.c` dentro de un objeto. */
export function campo(obj, ruta) {
  if (!ruta) return undefined;
  return ruta.split('.').reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), obj);
}

export const esExito = (r) => r.estado >= 200 && r.estado < 300;

/** Cuántos de cada estado, y los cuerpos distintos con cuántas veces salió cada uno. */
export function resumir(respuestas, ignorar) {
  const porEstado = new Map();
  const porCuerpo = new Map();
  for (const r of respuestas) {
    porEstado.set(r.estado, (porEstado.get(r.estado) ?? 0) + 1);
    const k = `${r.estado} ${normalizar(r, ignorar)}`;
    porCuerpo.set(k, (porCuerpo.get(k) ?? 0) + 1);
  }
  const ms = respuestas.map((r) => r.ms).sort((a, b) => a - b);
  return {
    porEstado: [...porEstado].sort((a, b) => a[0] - b[0]),
    porCuerpo: [...porCuerpo].sort((a, b) => b[1] - a[1]),
    ms: { min: ms[0] ?? 0, mediana: ms[Math.floor(ms.length / 2)] ?? 0, max: ms.at(-1) ?? 0 },
  };
}

export function imprimirResumen(titulo, respuestas, ignorar) {
  const r = resumir(respuestas, ignorar);
  console.log(`\n${titulo}`);
  console.log(`  estados: ${r.porEstado.map(([e, n]) => `${n}×${e === 0 ? 'error de red' : e}`).join(', ')}`);
  console.log(`  tiempos: mín ${r.ms.min} ms, mediana ${r.ms.mediana} ms, máx ${r.ms.max} ms`);
  console.log(`  cuerpos distintos: ${r.porCuerpo.length}`);
  for (const [k, n] of r.porCuerpo) console.log(`    ${String(n).padStart(4)}× ${k.length > 300 ? `${k.slice(0, 300)}…` : k}`);
  return r;
}

/** Guarda todo lo enviado y recibido, para la evidencia del hallazgo. Sin los tokens. */
export function guardarSalida(o, datos) {
  if (!o.salida) return;
  const sinSecretos = JSON.parse(
    JSON.stringify(datos, (k, v) => (k === 'token' || k === 'authorization' ? (v ? '<oculto>' : v) : v)),
  );
  writeFileSync(o.salida, `${JSON.stringify({ fecha: new Date().toISOString(), url: o.url, ...sinSecretos }, null, 2)}\n`);
  console.log(`\nGuardado en ${o.salida}`);
}

export const nuevaClave = () => randomUUID();
