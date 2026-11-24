#!/usr/bin/env node
// Dispara N pedidos en simultáneo y resume los estados y los cuerpos distintos.
// Sirve para «dos choferes aceptan el mismo viaje», «20 cobros del mismo viaje», «el mismo email
// registrado 20 veces» o mezclas («aceptar contra cancelar») con una lista de pedidos en el JSON.
// Node 22, sin dependencias. Ver ataque/README.md y docs/ataque.md.

import { enviar, esExito, guardarSalida, imprimirResumen, leerOpciones, nuevaClave, reemplazar, salirConError } from './comun.mjs';

const AYUDA = `Uso: node ataque/carrera.mjs --url <base> --ruta <ruta> [opciones]
     node ataque/carrera.mjs --config carrera.json [opciones que pisan el JSON]

  -u, --url URL            base de la API (o ATAQUE_URL). Ej.: http://localhost:8080/api
  -m, --metodo M           POST por defecto
  -r, --ruta R             ruta; acepta {i} (número de pedido), {uuid} (uno nuevo) y {corrida}
  -b, --cuerpo JSON        cuerpo JSON, o @archivo.json. Acepta {i}, {uuid} y {corrida} en los textos
  -t, --token T            token (se repite: un token por pedido, en ronda). Sin "Bearer ", se agrega
      --tokens ARCHIVO     un token por línea
  -H, --encabezado "K: V"  encabezado extra (se repite)
  -n, --n N                cuántos pedidos (20). Con "pedidos" en el JSON, se usan esos
      --idem MODO          nueva (una clave por pedido, por defecto) | misma | ninguna
      --clave-encabezado K Idempotency-Key por defecto
      --max-exitos K       si hay más de K respuestas 2xx, marca FALLA y sale con código 2
      --calentar-ruta R    antes de la ráfaga, N GET a esta ruta para abrir las conexiones
      --timeout MS         15000
      --ignorar a,b        campos que no cuentan al comparar cuerpos (requestId,request_id,timestamp,traceId)
  -o, --salida ARCHIVO     guarda pedidos y respuestas (sin tokens) como evidencia
      --detalle            imprime cada respuesta
  -h, --ayuda

JSON de configuración: las mismas claves, más "cuerpo" (objeto), "tokens" (lista),
"encabezados" (objeto) y "pedidos": [{ "metodo", "ruta", "cuerpo", "token", "idem" }, ...].`;

const o = leerOpciones(
  {
    n: { type: 'string', short: 'n' },
    idem: { type: 'string' },
    'max-exitos': { type: 'string' },
    'calentar-ruta': { type: 'string' },
    detalle: { type: 'boolean' },
  },
  AYUDA,
);

const n = Number(o.n ?? 20);
const modo = o.idem ?? 'nueva';
if (!['nueva', 'misma', 'ninguna'].includes(modo)) salirConError(`--idem: nueva, misma o ninguna (llegó "${modo}")`);
if (!Array.isArray(o.pedidos) && !o.ruta) salirConError(`Falta --ruta o "pedidos" en el JSON.\n\n${AYUDA}`);
if (!Number.isInteger(n) || n < 1 || n > 500) salirConError('--n tiene que estar entre 1 y 500 (esto no es un DoS)');

// Todos los pedidos se arman antes de disparar: en la ráfaga no queda nada por calcular.
const claveComun = nuevaClave();
const base = Array.isArray(o.pedidos) ? o.pedidos : Array.from({ length: n }, () => ({}));
const pedidos = base.map((p, i) => {
  const m = p.idem ?? modo;
  const tokens = o.tokens;
  return {
    metodo: (p.metodo ?? o.metodo).toUpperCase(),
    ruta: reemplazar(p.ruta ?? o.ruta, i),
    cuerpo: reemplazar(p.cuerpo ?? o.cuerpo, i),
    token: p.token ?? (tokens.length ? tokens[i % tokens.length] : undefined),
    clave: p.clave ?? (m === 'misma' ? claveComun : m === 'nueva' ? nuevaClave() : null),
    encabezados: p.encabezados,
  };
});

if (o['calentar-ruta']) {
  // Abre las conexiones antes: si no, la ráfaga se escalona mientras se conecta cada una.
  await Promise.all(pedidos.map(() => enviar(o, { metodo: 'GET', ruta: o['calentar-ruta'] })));
}

console.log(`Disparando ${pedidos.length} pedidos a la vez contra ${o.url} (idempotencia: ${modo})`);
const inicio = performance.now();
const respuestas = await Promise.all(pedidos.map((p) => enviar(o, p)));
console.log(`Ráfaga completa en ${Math.round(performance.now() - inicio)} ms`);

if (o.detalle) {
  respuestas.forEach((r, i) => {
    const p = pedidos[i];
    console.log(`  #${i} ${p.metodo} ${p.ruta} → ${r.estado} ${r.ms} ms ${r.texto.slice(0, 200)}`);
  });
}

// Agrupado por ruta: en una mezcla (aceptar contra cancelar) cada operación tiene su resumen.
const rutas = [...new Set(pedidos.map((p) => `${p.metodo} ${p.ruta}`))];
const exitos = respuestas.filter(esExito).length;
if (rutas.length === 1) {
  imprimirResumen(rutas[0], respuestas, o.ignorar);
} else {
  for (const ruta of rutas) {
    const deEsta = respuestas.filter((_, i) => `${pedidos[i].metodo} ${pedidos[i].ruta}` === ruta);
    imprimirResumen(ruta, deEsta, o.ignorar);
  }
}

let codigo = 0;
console.log(`\nRespuestas 2xx: ${exitos} de ${respuestas.length}`);
if (o['max-exitos'] !== undefined) {
  const max = Number(o['max-exitos']);
  if (exitos > max) {
    console.log(`FALLA POSIBLE: se esperaban como mucho ${max} respuestas 2xx. Confirmalo leyendo el estado del recurso.`);
    codigo = 2;
  } else {
    console.log(`OK: no más de ${max} respuestas 2xx.`);
  }
}
if (respuestas.some((r) => r.estado >= 500 || r.estado === 0)) {
  console.log('OJO: hubo 5xx o errores de red. Un 500 bajo concurrencia suele ser un deadlock o un error de unicidad sin capturar.');
}

guardarSalida(o, { pedidos, respuestas: respuestas.map(({ json: _json, ...r }) => r) });
process.exit(codigo);
