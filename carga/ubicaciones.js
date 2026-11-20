// Escenario de k6 para 6.6: 500 choferes (un ping cada 2 s = 250/s), búsquedas y /health en paralelo.
// Modelo abierto (constant-arrival-rate): si el servidor no da abasto, k6 lo registra como
// iteraciones omitidas (dropped_iterations) en vez de bajar el ritmo en silencio.
// Todo es determinista: sin Math.random, la misma secuencia de posiciones en cada corrida.
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://location:3004';
const TOKEN_SERVICIO = __ENV.TOKEN_SERVICIO;
const CALENTAMIENTO_S = Number(__ENV.CALENTAMIENTO_S || 30);
const MEDICION_S = Number(__ENV.MEDICION_S || 300);
const PINGS_POR_S = Number(__ENV.PINGS_POR_S || 250);
const BUSQUEDAS_POR_S = Number(__ENV.BUSQUEDAS_POR_S || 20);
const CHOFERES = 500;
const ORIGEN = { lat: -34.6037, lng: -58.3816 };
const METROS_POR_GRADO = 111_195;

if (!TOKEN_SERVICIO) throw new Error('falta TOKEN_SERVICIO');
const tokens = new SharedArray('tokens', () => JSON.parse(open('/secretos/tokens.json')));

const pingsEnviados = new Counter('pings_enviados');
const pingsAceptados = new Counter('pings_aceptados');
const pingsFallidos = new Counter('pings_fallidos');
const busquedasOk = new Counter('busquedas_ok');
const busquedasFallidas = new Counter('busquedas_fallidas');

const duracion = `${CALENTAMIENTO_S + MEDICION_S}s`;
const escenario = (rate, exec_, vus) => ({
  executor: 'constant-arrival-rate',
  rate,
  timeUnit: '1s',
  duration: duracion,
  preAllocatedVUs: vus,
  maxVUs: vus * 5,
  exec: exec_,
  gracefulStop: '10s',
});

export const options = {
  discardResponseBodies: true,
  scenarios: {
    pings: escenario(PINGS_POR_S, 'ping', 100),
    busquedas: escenario(BUSQUEDAS_POR_S, 'buscar', 20),
    salud: escenario(2, 'salud', 2),
  },
  // Umbrales informativos: no cortan la corrida. También fuerzan las submétricas por fase.
  thresholds: {
    'http_req_duration{escenario:pings,fase:medicion}': ['p(95)<50'],
    'http_req_duration{escenario:busquedas,fase:medicion}': ['p(95)<100'],
    'http_req_duration{escenario:salud,fase:medicion}': ['p(95)<50'],
    'http_req_duration{escenario:pings,fase:calentamiento}': ['max>=0'],
    'http_req_duration{escenario:busquedas,fase:calentamiento}': ['max>=0'],
    'http_req_failed{fase:medicion}': ['rate<0.01'],
    'dropped_iterations{scenario:pings}': ['count>=0'],
    'dropped_iterations{scenario:busquedas}': ['count>=0'],
    'pings_enviados{fase:medicion}': ['count>=0'],
    'pings_aceptados{fase:medicion}': ['count>=0'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const fase = () => (exec.instance.currentTestRunDuration < CALENTAMIENTO_S * 1000 ? 'calentamiento' : 'medicion');

/** Punto a `metros` del Obelisco con rumbo `angulo` (aproximación plana, suficiente para la carga). */
function punto(metros, angulo) {
  return {
    lat: ORIGEN.lat + (metros * Math.cos(angulo)) / METROS_POR_GRADO,
    lng: ORIGEN.lng + (metros * Math.sin(angulo)) / (METROS_POR_GRADO * Math.cos((ORIGEN.lat * Math.PI) / 180)),
  };
}

export function ping() {
  const i = exec.scenario.iterationInTest;
  const chofer = i % CHOFERES; // cada chofer, una vez cada 500 iteraciones = cada 2 s a 250/s
  const vuelta = Math.floor(i / CHOFERES);
  // Cada chofer recorre un círculo propio (de 300 m a 10 km del centro), avanzando un poco por vuelta.
  const radio = 300 + ((chofer * 7919) % 9700);
  const posicion = punto(radio, chofer * 2.399963 + vuelta * 0.01);
  const tags = { escenario: 'pings', fase: fase() };
  pingsEnviados.add(1, tags);
  const res = http.post(`${BASE}/ubicaciones`, JSON.stringify(posicion), {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[chofer]}` },
    tags,
  });
  if (res.status === 204) pingsAceptados.add(1, tags);
  else pingsFallidos.add(1, tags);
  check(res, { 'ping 204': (r) => r.status === 204 });
}

export function buscar() {
  const q = exec.scenario.iterationInTest;
  const origen = punto((q * 104729) % 8000, q * 2.4);
  const tags = { escenario: 'busquedas', fase: fase() };
  const res = http.get(`${BASE}/interno/candidatos?lat=${origen.lat}&lng=${origen.lng}&radioMetros=5000&limite=10`, {
    headers: { 'x-token-servicio': TOKEN_SERVICIO },
    tags,
  });
  if (res.status === 200) busquedasOk.add(1, tags);
  else busquedasFallidas.add(1, tags);
  check(res, { 'búsqueda 200': (r) => r.status === 200 });
}

export function salud() {
  http.get(`${BASE}/health`, { tags: { escenario: 'salud', fase: fase() } });
}

const v = (data, nombre, campo) => data.metrics[nombre]?.values?.[campo] ?? 0;

export function handleSummary(data) {
  const p = (m) => `p50 ${v(data, m, 'med').toFixed(1)} | p95 ${v(data, m, 'p(95)').toFixed(1)} | p99 ${v(data, m, 'p(99)').toFixed(1)} ms`;
  const texto = [
    `pings enviados ${v(data, 'pings_enviados', 'count')} | aceptados ${v(data, 'pings_aceptados', 'count')} | fallidos ${v(data, 'pings_fallidos', 'count')} | omitidos por k6 ${v(data, 'dropped_iterations{scenario:pings}', 'count')}`,
    `búsquedas ok ${v(data, 'busquedas_ok', 'count')} | fallidas ${v(data, 'busquedas_fallidas', 'count')} | omitidas ${v(data, 'dropped_iterations{scenario:busquedas}', 'count')}`,
    `pings      (medición): ${p('http_req_duration{escenario:pings,fase:medicion}')}`,
    `búsquedas  (medición): ${p('http_req_duration{escenario:busquedas,fase:medicion}')}`,
    `/health    (medición): ${p('http_req_duration{escenario:salud,fase:medicion}')}`,
    `errores    (medición): ${(v(data, 'http_req_failed{fase:medicion}', 'rate') * 100).toFixed(2)} %`,
    '',
  ].join('\n');
  return { '/resultados/resumen-k6.json': JSON.stringify(data, null, 2), stdout: texto };
}
