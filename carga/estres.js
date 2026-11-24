// Rampa de estrés por escalones (escenario B de docs/mediciones.md): k6 hace de pasajero y crea viajes en
// modelo abierto, un escalón por tasa (1, 2, 4, 8, 16 y 32 viajes/s, 60 s cada uno, después de 30 s de
// calentamiento). Los choferes que aceptan son los de carga/estres-choferes.mjs (Node, por el SSE); el
// fondo de 250 pings/s corre en OTRO k6 (ubicaciones.js), así sus usuarios virtuales no se mezclan con
// los de los pasajeros.
//
// - Cada usuario virtual es un pasajero distinto (por su id en la prueba, de tokens-viajes.json): un
//   usuario corre una iteración por vez, así que su pasajero nunca tiene dos viajes activos.
// - Una iteración: crear el viaje → consultar su estado cada 100 ms hasta ASIGNADO o SIN_CHOFERES (o
//   10 s) → cancelarlo si sigue activo y confirmarlo, antes de que el pasajero vuelva a pedir. Si no se
//   pudo liberar, ese pasajero no se usa más.
// - Cada pedido lleva `etapa` (el escalón) y `ventana`: `transicion` los primeros TRANSICION_S segundos
//   del escalón, `estable` el resto. Los números del informe son los de la ventana estable.
// - Los umbrales son los criterios de degradación: un umbral incumplido NO corta la corrida.
import exec from 'k6/execution';
import http from 'k6/http';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import { sleep } from 'k6';

const DISPATCH = __ENV.DISPATCH_URL || 'http://dispatch:3005';
const CALENTAMIENTO_S = Number(__ENV.CALENTAMIENTO_S || 30);
const ETAPA_S = Number(__ENV.ETAPA_S || 60);
const TRANSICION_S = Number(__ENV.TRANSICION_S || 15);
const ETAPAS = (__ENV.ETAPAS || '1,2,4,8,16,32').split(',').map(Number);
const ESPERA_MS = Number(__ENV.ESPERA_MS || 10_000);
const SONDEO_MS = 100;

const pasajeros = new SharedArray('pasajeros', () => JSON.parse(open('/secretos/tokens-viajes.json')).pasajeros);

// Córdoba (zona «Carga Córdoba»): los choferes de prueba están a menos de 2 km.
const ORIGEN = { lat: -31.4201, lng: -64.1888 };
const DESTINO = { lat: -31.4135, lng: -64.1811 };

const iniciados = new Counter('viajes_iniciados');
const creados = new Counter('viajes_creados');
const asignados = new Counter('viajes_asignados');
const sinChoferes = new Counter('viajes_sin_choferes');
const sinResolver = new Counter('viajes_sin_resolver');
const ubicacion503 = new Counter('viajes_503_ubicacion');
const errores = new Counter('viajes_errores');
const pasajeroInutilizado = new Counter('pasajeros_inutilizados');
const hastaAsignacion = new Trend('tiempo_hasta_asignacion', true);

const maxVus = (tasa) => Math.min(250, Math.max(10, tasa * 8));
const escenarios = {
  calentamiento: {
    executor: 'constant-arrival-rate',
    rate: 1,
    timeUnit: '1s',
    duration: `${CALENTAMIENTO_S}s`,
    preAllocatedVUs: 5,
    maxVUs: 20,
    exec: 'viaje',
    gracefulStop: '15s',
    tags: { etapa: '0', tasa: '1' },
  },
};
ETAPAS.forEach((tasa, i) => {
  escenarios[`etapa_${i + 1}`] = {
    executor: 'constant-arrival-rate',
    rate: tasa,
    timeUnit: '1s',
    duration: `${ETAPA_S}s`,
    startTime: `${CALENTAMIENTO_S + i * ETAPA_S}s`,
    preAllocatedVUs: Math.max(2, tasa * 2),
    maxVUs: maxVus(tasa),
    exec: 'viaje',
    gracefulStop: '15s',
    tags: { etapa: String(i + 1), tasa: String(tasa) },
  };
});

// Umbrales: los criterios de degradación de cada etapa en su ventana estable (no cortan la corrida), y
// los que fuerzan las submétricas que lee el resumen.
const umbrales = {};
ETAPAS.forEach((_, i) => {
  const e = `etapa:${i + 1},ventana:estable`;
  umbrales[`http_req_duration{nombre:crear,${e}}`] = ['p(95)<500'];
  umbrales[`tiempo_hasta_asignacion{${e}}`] = ['p(95)<2000'];
  for (const m of ['viajes_iniciados', 'viajes_creados', 'viajes_asignados', 'viajes_sin_choferes', 'viajes_sin_resolver', 'viajes_503_ubicacion', 'viajes_errores']) {
    umbrales[`${m}{${e}}`] = ['count>=0'];
  }
  umbrales[`http_req_duration{nombre:estado,${e}}`] = ['max>=0'];
  umbrales[`http_req_duration{nombre:cancelar,${e}}`] = ['max>=0'];
  umbrales[`dropped_iterations{scenario:etapa_${i + 1}}`] = ['count>=0'];
});

export const options = {
  scenarios: escenarios,
  thresholds: umbrales,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

// Por usuario virtual: si su pasajero no se pudo liberar, no se vuelve a usar.
let inutilizado = false;

function ventana() {
  const desdeInicio = (Date.now() - exec.scenario.startTime) / 1000;
  return exec.scenario.name !== 'calentamiento' && desdeInicio >= TRANSICION_S ? 'estable' : 'transicion';
}

const ACTIVOS = ['BUSCANDO', 'ASIGNADO', 'EN_CAMINO', 'EN_CURSO'];

function conClave(url, token, cuerpo, nombre) {
  const params = {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
    tags: { nombre },
  };
  let res;
  for (let intento = 0; intento <= 2; intento++) {
    if (intento > 0) sleep(0.2 * intento);
    res = http.post(url, JSON.stringify(cuerpo), params);
    const enCurso = res.status === 409 && codigo(res) === 'CLAVE_IDEMPOTENCIA_EN_CURSO';
    // 503 UBICACION_NO_DISPONIBLE es una respuesta definitiva (falla cerrado): no se reintenta.
    const transitorio = res.status === 0 || res.status === 502 || res.status === 504 || (res.status === 503 && codigo(res) !== 'UBICACION_NO_DISPONIBLE');
    if (!enCurso && !transitorio) return res;
  }
  return res;
}

function codigo(res) {
  try {
    return res.json('error.code');
  } catch {
    return null;
  }
}

function estadoDe(id, token) {
  const r = http.get(`${DISPATCH}/solicitudes/${id}`, { headers: { authorization: `Bearer ${token}` }, tags: { nombre: 'estado' } });
  return r.status === 200 ? r.json('estado') : null;
}

export function viaje() {
  const pasajero = pasajeros[exec.vu.idInTest - 1];
  exec.vu.metrics.tags.ventana = ventana();
  if (!pasajero) {
    errores.add(1, { motivo: 'sin_cuenta_de_pasajero' });
    return;
  }
  if (inutilizado) {
    pasajeroInutilizado.add(1);
    return;
  }
  iniciados.add(1);
  const n = exec.scenario.iterationInTest;
  const origen = { lat: ORIGEN.lat + ((n % 9) - 4) * 0.002, lng: ORIGEN.lng + ((Math.floor(n / 9) % 9) - 4) * 0.002 };
  const t0 = Date.now();
  const creada = conClave(`${DISPATCH}/solicitudes`, pasajero.token, { origen, destino: DESTINO }, 'crear');
  if (creada.status !== 201) {
    if (creada.status === 503 && codigo(creada) === 'UBICACION_NO_DISPONIBLE') ubicacion503.add(1);
    else errores.add(1, { motivo: `crear_${creada.status}_${codigo(creada) ?? ''}` });
    return;
  }
  creados.add(1);
  const id = creada.json('id');
  let estado = creada.json('estado');
  // Hasta que se resuelva: ASIGNADO o SIN_CHOFERES (consultando cada 100 ms, hasta ESPERA_MS).
  while (estado === 'BUSCANDO' && Date.now() - t0 < ESPERA_MS) {
    sleep(SONDEO_MS / 1000);
    estado = estadoDe(id, pasajero.token) ?? estado;
  }
  if (estado === 'ASIGNADO') {
    asignados.add(1);
    hastaAsignacion.add(Date.now() - t0);
  } else if (estado === 'SIN_CHOFERES') {
    sinChoferes.add(1);
  } else {
    sinResolver.add(1);
  }
  // Liberar antes de reusar al pasajero: cancelar si sigue activo y confirmarlo.
  if (ACTIVOS.includes(estado)) {
    const c = conClave(`${DISPATCH}/solicitudes/${id}/cancelar`, pasajero.token, {}, 'cancelar');
    if (c.status !== 200 && codigo(c) !== 'TRANSICION_INVALIDA') errores.add(1, { motivo: `cancelar_${c.status}_${codigo(c) ?? ''}` });
    let final = estadoDe(id, pasajero.token);
    for (let i = 0; i < 50 && (final === null || ACTIVOS.includes(final)); i++) {
      sleep(0.1);
      final = estadoDe(id, pasajero.token);
    }
    if (final === null || ACTIVOS.includes(final)) {
      errores.add(1, { motivo: 'no_se_pudo_liberar' });
      inutilizado = true;
    }
  }
}

const valor = (data, nombre, campo) => data.metrics[nombre]?.values?.[campo] ?? null;

export function handleSummary(data) {
  const etapas = ETAPAS.map((tasa, i) => {
    const e = `etapa:${i + 1},ventana:estable`;
    const cuenta = (m) => valor(data, `${m}{${e}}`, 'count') ?? 0;
    const lat = (m) => ({
      p50: valor(data, m, 'med'),
      p95: valor(data, m, 'p(95)'),
      p99: valor(data, m, 'p(99)'),
      max: valor(data, m, 'max'),
    });
    const estableS = ETAPA_S - TRANSICION_S;
    return {
      etapa: i + 1,
      tasa,
      previstos_etapa: tasa * ETAPA_S,
      previstos_ventana_estable: tasa * estableS,
      iniciados_ventana_estable: cuenta('viajes_iniciados'),
      omitidos_por_k6_etapa: valor(data, `dropped_iterations{scenario:etapa_${i + 1}}`, 'count') ?? 0,
      creados: cuenta('viajes_creados'),
      asignados: cuenta('viajes_asignados'),
      sin_choferes: cuenta('viajes_sin_choferes'),
      sin_resolver: cuenta('viajes_sin_resolver'),
      ubicacion_503: cuenta('viajes_503_ubicacion'),
      errores: cuenta('viajes_errores'),
      viajes_por_s: Number((cuenta('viajes_iniciados') / estableS).toFixed(2)),
      crear_ms: lat(`http_req_duration{nombre:crear,${e}}`),
      hasta_asignacion_ms: lat(`tiempo_hasta_asignacion{${e}}`),
    };
  });
  const lineas = etapas.map(
    (x) =>
      `etapa ${x.etapa} (${x.tasa}/s): iniciados ${x.iniciados_ventana_estable}/${x.previstos_ventana_estable} | omitidos ${x.omitidos_por_k6_etapa} | asignados ${x.asignados} | sin resolver ${x.sin_resolver} | errores ${x.errores} | crear p95 ${x.crear_ms.p95?.toFixed(0)} ms | asignación p95 ${x.hasta_asignacion_ms.p95?.toFixed(0)} ms`,
  );
  return {
    '/resultados/resumen-k6.json': JSON.stringify(data, null, 2),
    '/resultados/etapas-k6.json': JSON.stringify({ calentamiento_s: CALENTAMIENTO_S, etapa_s: ETAPA_S, transicion_s: TRANSICION_S, etapas }, null, 2),
    stdout: `${lineas.join('\n')}\npasajeros inutilizados: ${valor(data, 'pasajeros_inutilizados', 'count') ?? 0}\n`,
  };
}
