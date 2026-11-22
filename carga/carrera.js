// Carrera de la asignación única (6.3) con k6, contra el sistema en contenedores: 50 choferes aceptan a
// la vez las 50 ofertas de la MISMA solicitud. Lo corre carga/carrera.ps1, que antes prepara la
// solicitud y deja en /resultados/ofertas.json las ofertas leídas de la base (sin tokens).
//
// Un solo VU manda las 50 aceptaciones en un http.batch: salen juntas, como el Promise.all del test
// services/dispatch/tests/concurrencia/asignacion-unica.test.ts. Cada una con el token de su chofer y
// su propia Idempotency-Key.
import { check } from 'k6';
import http from 'k6/http';

const DISPATCH = __ENV.DISPATCH_URL || 'http://dispatch:3005';
const tokens = JSON.parse(open('/secretos/tokens.json'));
const ofertas = JSON.parse(open('/resultados/ofertas.json'));

export const options = {
  scenarios: {
    carrera: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '60s' },
  },
  // Las 50 en paralelo, sin el tope por defecto de k6 (10 por lote, 6 por host).
  batch: 50,
  batchPerHost: 50,
  // Si algún check falla, k6 termina con error.
  thresholds: { checks: ['rate==1'] },
};

// 200 y 409 son las respuestas esperadas de una aceptación: el 409 del que pierde no es una falla HTTP.
http.setResponseCallback(http.expectedStatuses(200, 409));

export default function () {
  const pedidos = ofertas.map((o) => ({
    method: 'POST',
    url: `${DISPATCH}/ofertas/${o.ofertaId}/aceptar`,
    body: '{}',
    params: {
      headers: {
        Authorization: `Bearer ${tokens[o.indiceToken]}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': o.clave,
      },
      tags: { name: 'aceptar' },
    },
  }));

  const inicio = Date.now();
  const respuestas = http.batch(pedidos);
  const totalLoteMs = Date.now() - inicio;

  const filas = respuestas.map((r, i) => {
    let cuerpo = null;
    try {
      cuerpo = r.json();
    } catch {
      cuerpo = null;
    }
    return {
      ofertaId: ofertas[i].ofertaId,
      choferId: ofertas[i].choferId,
      estado: r.status,
      codigo: cuerpo && cuerpo.error ? cuerpo.error.code : null,
      choferAsignado: r.status === 200 && cuerpo ? cuerpo.choferId : null,
      duracionMs: Math.round(r.timings.duration),
    };
  });
  const ok = filas.filter((f) => f.estado === 200);
  const conflictos = filas.filter((f) => f.estado === 409);
  const ganador = ok.length === 1 ? ok[0].choferAsignado : null;

  check(filas, {
    'exactamente 1×200': () => ok.length === 1,
    'exactamente 49×409': () => conflictos.length === 49,
    'los 49 conflictos son SOLICITUD_NO_DISPONIBLE': () =>
      conflictos.length === 49 && conflictos.every((f) => f.codigo === 'SOLICITUD_NO_DISPONIBLE'),
    'el ganador es el chofer de la oferta aceptada': () => ok.length === 1 && ganador === ok[0].choferId,
  });

  // carrera.ps1 lee esta línea (k6 corre con --log-format raw). Sin tokens.
  const sumaDuracionesMs = filas.reduce((s, f) => s + f.duracionMs, 0);
  console.log(`RESULTADO ${JSON.stringify({ ganador, totalLoteMs, sumaDuracionesMs, filas })}`);
}

export function handleSummary(data) {
  return { '/resultados/resumen-k6.json': JSON.stringify(data, null, 2) };
}
