// Resume las corridas de una fecha en tablas Markdown (una fila por corrida y la mediana por estrategia).
//   node carga/resumir.mjs docs/mediciones/2026-11-19
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const carpeta = process.argv[2];
if (!carpeta || !existsSync(carpeta)) {
  console.error('Uso: node carga/resumir.mjs docs/mediciones/<fecha>');
  process.exit(1);
}

const leer = (ruta) => readFileSync(ruta, 'utf8').replace(/^﻿/, '');
// Series de /metrics (formato de texto de Prometheus): nombre, etiquetas (en cualquier orden) y valor.
const series = (texto) =>
  texto
    .split(/\r?\n/)
    .map((l) => l.match(/^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/))
    .filter(Boolean)
    .map(([, nombre, etiquetas = '', valor]) => ({
      nombre,
      etiquetas: Object.fromEntries([...etiquetas.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((e) => [e[1], e[2]])),
      valor: Number(valor),
    }));
// El primer nombre que aparezca con esas etiquetas (las demás etiquetas, como `servicio`, no importan).
// Varios nombres para leer el formato actual y el de las evidencias del 19/11, que no tenían
// `servicio` y llevaban el prefijo `location_` en el lag.
const metrica = (texto, nombres, etiquetas = {}) => {
  const todas = series(texto);
  for (const nombre of nombres) {
    const s = todas.find((x) => x.nombre === nombre && Object.entries(etiquetas).every(([k, v]) => x.etiquetas[k] === v));
    if (s) return s.valor;
  }
  return NaN;
};
const mb = (s) => {
  const [n, u] = [parseFloat(s), s.replace(/[\d.\s]/g, '')];
  return u.startsWith('GiB') ? n * 1024 : u.startsWith('KiB') ? n / 1024 : n;
};

// Corridas de medir.ps1 (ubicaciones, con o sin viajes): las que tienen `estrategia` en conteos.json.
// Las de estres.ps1 van en su propia sección, al final.
const esDeMedir = (d) =>
  d.isDirectory() && existsSync(join(carpeta, d.name, 'conteos.json')) && JSON.parse(leer(join(carpeta, d.name, 'conteos.json'))).estrategia;
const corridas = readdirSync(carpeta, { withFileTypes: true })
  .filter(esDeMedir)
  .map((d) => {
    const dir = join(carpeta, d.name);
    const conteos = JSON.parse(leer(join(dir, 'conteos.json')));
    const k6 = JSON.parse(leer(join(dir, 'resumen-k6.json')));
    const metricas = leer(join(dir, 'metrics.txt'));
    const v = (m, campo) => k6.metrics[m]?.values?.[campo] ?? NaN;
    // docker stats: solo las muestras de la ventana de medición (sin el calentamiento ni la espera
    // del final). `inicio` es el momento en que medir.ps1 lanzó k6.
    const segundosDelDia = (hhmmss) => hhmmss.split(':').reduce((acc, x) => acc * 60 + Number(x), 0);
    const desde = segundosDelDia(conteos.inicio.slice(11, 19)) + conteos.calentamiento_s;
    const hasta = desde + conteos.medicion_s;
    const stats = leer(join(dir, 'docker-stats.csv'))
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean)
      .map((l) => l.split(','))
      .filter((s) => segundosDelDia(s[0]) >= desde && segundosDelDia(s[0]) <= hasta);
    const de = (c) => stats.filter((s) => s[1] === c);
    const maxCpu = (c) => Math.max(...de(c).map((s) => parseFloat(s[2])));
    const prom = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
    const memLocation = Math.max(...de('viajes-carga-location-1').map((s) => mb(s[3].split('/')[0].trim())));
    const rps = (m) => (k6.metrics[m]?.values?.count ?? NaN) / conteos.medicion_s;
    return {
      nombre: d.name,
      estrategia: conteos.estrategia,
      enviados: conteos.pings_enviados,
      aceptados: conteos.pings_aceptados,
      enviadosMedicion: v('pings_enviados{fase:medicion}', 'count'),
      aceptadosMedicion: v('pings_aceptados{fase:medicion}', 'count'),
      muestrasStats: de('viajes-carga-location-1').length,
      omitidos: conteos.pings_omitidos_k6,
      fallidos: conteos.pings_fallidos,
      guardados: conteos.historial_filas,
      descartados: conteos.historial_descartados,
      drenajeS: conteos.historial_drenaje_ms / 1000,
      pingP50: v('http_req_duration{escenario:pings,fase:medicion}', 'med'),
      pingP95: v('http_req_duration{escenario:pings,fase:medicion}', 'p(95)'),
      pingP99: v('http_req_duration{escenario:pings,fase:medicion}', 'p(99)'),
      busP50: v('http_req_duration{escenario:busquedas,fase:medicion}', 'med'),
      busP95: v('http_req_duration{escenario:busquedas,fase:medicion}', 'p(95)'),
      busP99: v('http_req_duration{escenario:busquedas,fase:medicion}', 'p(99)'),
      saludP50: v('http_req_duration{escenario:salud,fase:medicion}', 'med'),
      saludP95: v('http_req_duration{escenario:salud,fase:medicion}', 'p(95)'),
      saludP99: v('http_req_duration{escenario:salud,fase:medicion}', 'p(99)'),
      pingsPorS: rps('pings_aceptados{fase:medicion}'),
      errores: v('http_req_failed{fase:medicion}', 'rate') * 100,
      lagP99: metrica(metricas, ['event_loop_lag_ms', 'location_event_loop_lag_ms'], { quantile: '0.99' }),
      lagMax: metrica(metricas, ['event_loop_lag_max_ms', 'location_event_loop_lag_max_ms']),
      rssMb: metrica(metricas, ['process_resident_memory_bytes']) / 1048576,
      memLocationMb: memLocation,
      cpuLocationProm: prom(de('viajes-carga-location-1').map((s) => parseFloat(s[2]))),
      cpuLocationMax: maxCpu('viajes-carga-location-1'),
      cpuPostgresProm: prom(de('viajes-carga-postgres-1').map((s) => parseFloat(s[2]))),
      cpuRedisProm: prom(de('viajes-carga-redis-1').map((s) => parseFloat(s[2]))),
      cpuDispatchProm: de('viajes-carga-dispatch-1').length ? prom(de('viajes-carga-dispatch-1').map((s) => parseFloat(s[2]))) : NaN,
      cpuDispatchMax: de('viajes-carga-dispatch-1').length ? maxCpu('viajes-carga-dispatch-1') : NaN,
      viajes: conteos.solicitudes ?? null,
      correccion: conteos.correccion ?? null,
    };
  })
  .sort((a, b) => a.nombre.localeCompare(b.nombre));

const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const mediana = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

console.log('#### Conteos por corrida\n');
console.log('«Medición» = los 5 min sin el calentamiento. «Corrida completa» = calentamiento + medición (330 s).\n');
console.log('| Corrida | Pings enviados: medición / corrida completa | Aceptados (204): medición / corrida completa | Omitidos por k6 (corrida completa) | Con error (corrida completa) | Guardados en historial (corrida completa) | Descartados (cola llena) | Escritura pendiente al terminar k6 (s) |');
console.log('|---|---|---|---|---|---|---|---|');
for (const c of corridas) {
  console.log(
    `| ${c.nombre} | ${c.enviadosMedicion} / ${c.enviados} | ${c.aceptadosMedicion} / ${c.aceptados} | ${c.omitidos} | ${c.fallidos} | ${c.guardados} | ${c.descartados} | ${f(c.drenajeS)} |`,
  );
}

console.log('\n#### Latencia y recursos por corrida\n');
console.log('Latencias, pings/s, errores y CPU: solo la medición. Lag y RSS: desde que arranca location (no se pueden separar).\n');
console.log('| Corrida | Pings p50 / p95 / p99 (ms) | Búsquedas p50 / p95 / p99 (ms) | /health p50 / p95 / p99 (ms) | Pings/s | Errores (%) | Lag p99 / máx (ms) | RSS location (MB) | CPU location prom. / máx (%) | CPU Postgres prom. (%) | CPU Redis prom. (%) | Muestras de CPU |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const c of corridas) {
  console.log(
    `| ${c.nombre} | ${f(c.pingP50)} / ${f(c.pingP95)} / ${f(c.pingP99)} | ${f(c.busP50)} / ${f(c.busP95)} / ${f(c.busP99)} | ${f(c.saludP50)} / ${f(c.saludP95)} / ${f(c.saludP99)} | ${f(c.pingsPorS)} | ${f(c.errores, 2)} | ${f(c.lagP99)} / ${f(c.lagMax)} | ${f(c.rssMb, 0)} | ${f(c.cpuLocationProm, 0)} / ${f(c.cpuLocationMax, 0)} | ${f(c.cpuPostgresProm, 0)} | ${f(c.cpuRedisProm, 0)} | ${c.muestrasStats} |`,
  );
}

console.log('\n#### Mediana de las corridas por estrategia (3 por estrategia)\n');
console.log('| Estrategia | Corridas | Pings p95 (ms) | Pings p99 (ms) | Búsquedas p95 (ms) | Búsquedas p99 (ms) | /health p95 (ms) | Pings/s | Lag p99 (ms) | Lag máx (ms) | RSS (MB) | CPU location (%) | CPU Postgres (%) |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const e of ['ingenua', 'optimizada']) {
  const cs = corridas.filter((c) => c.estrategia === e);
  if (!cs.length) continue;
  const m = (k, d = 1) => f(mediana(cs.map((c) => c[k])), d);
  console.log(
    `| ${e} | ${cs.length} | ${m('pingP95')} | ${m('pingP99')} | ${m('busP95')} | ${m('busP99')} | ${m('saludP95')} | ${m('pingsPorS')} | ${m('lagP99')} | ${m('lagMax')} | ${m('rssMb', 0)} | ${m('cpuLocationProm', 0)} | ${m('cpuPostgresProm', 0)} |`,
  );
}

// ===================== Viajes en paralelo (escenario A: medir.ps1 -Solicitudes) =====================

const conViajes = corridas.filter((c) => c.viajes && c.viajes.pasajeros !== undefined);
const ms = (x) => (x === null || x === undefined ? '—' : String(x));
const seg = (x) => (x === null || x === undefined ? '—' : x === '+Inf' ? '> 2 s' : `${Math.round(x * 1000)} ms`);
if (conViajes.length) {
  console.log('\n### Viajes en paralelo bajo la carga de 6.6 (escenario A)\n');
  console.log('Solo la ventana de medición. Cliente: percentiles exactos. Servidor: por cubeta (el borde superior de la cubeta del percentil).\n');
  console.log('| Corrida | Viajes/s | Asignados/s | `POST /solicitudes` cliente p50 / p95 / p99 (ms) | Hasta la asignación, cliente p50 / p95 / p99 (ms) | Hasta la asignación, servidor p50 / p95 / p99 | 503 ubicación | Sin choferes | Sin resolver | Errores | Lag dispatch p99 | RSS dispatch / location al final (MB) | CPU dispatch prom. / máx (%) | Pings: fondo / choferes de prueba (por s) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of conViajes) {
    const v = c.viajes;
    const cr = v.cliente_ms.crear;
    const as = v.cliente_ms.hasta_asignacion;
    const sv = v.servidor.hasta_asignacion_s;
    console.log(
      `| ${c.nombre} | ${v.solicitudes_por_s} | ${v.asignadas_por_s} | ${ms(cr.p50)} / ${ms(cr.p95)} / ${ms(cr.p99)} | ${ms(as.p50)} / ${ms(as.p95)} / ${ms(as.p99)} | ${seg(sv.p50)} / ${seg(sv.p95)} / ${seg(sv.p99)} | ${v.ubicacion_no_disponible_503} | ${v.sin_choferes} | ${v.timeouts} | ${v.errores_total} | ${seg(v.servidor.lag_dispatch_s.p99)} | ${v.servidor.memoria_mb.dispatch.fin} / ${v.servidor.memoria_mb.location.fin} | ${f(c.cpuDispatchProm, 0)} / ${f(c.cpuDispatchMax, 0)} | ${f(c.pingsPorS, 0)} / ${v.choferes_prueba.pings_por_s_en_la_ventana} |`,
    );
  }
  console.log('\n#### Competencia y corrección (escenario A)\n');
  console.log('| Corrida | Iteraciones | Ofertas recibidas | Aceptadas (200) | 409 esperados | Errores al aceptar | Ofertas a no aptos (SSE / base) | Viajes activos al final | Viajes de no aptos | Fuera de Córdoba | Asignados sin flota |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of conViajes) {
    const ch = c.viajes.choferes_prueba;
    const k = c.correccion ?? {};
    const esperados = Object.entries(ch.rechazos_409_esperados).map(([x, n]) => `${x} ${n}`).join(', ') || '0';
    const errAceptar = Object.entries(ch.aceptar_errores).map(([x, n]) => `${x} ${n}`).join(', ') || '0';
    console.log(
      `| ${c.nombre} | ${c.viajes.iteraciones} | ${ch.ofertas_recibidas} | ${ch.aceptadas_200} | ${esperados} | ${errAceptar} | ${ch.ofertas_a_no_aptos} / ${k.ofertas_a_no_aptos ?? '—'} | ${k.viajes_activos ?? '—'} | ${k.viajes_de_no_aptos ?? '—'} | ${k.viajes_fuera_de_cordoba ?? '—'} | ${k.asignados_sin_flota ?? '—'} |`,
    );
  }
  console.log('\n#### Mediana de las corridas por estrategia (escenario A)\n');
  console.log('| Estrategia | Corridas | Viajes/s | `POST /solicitudes` p50 / p95 / p99 (ms) | Hasta la asignación p50 / p95 / p99 (ms) | 503 ubicación (% de los intentos) | Lag dispatch p99 (ms, cubeta) | CPU dispatch prom. (%) | RSS dispatch / location (MB) |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const e of ['ingenua', 'optimizada']) {
    const cs = conViajes.filter((c) => c.estrategia === e);
    if (!cs.length) continue;
    const m = (fn, d = 0) => f(mediana(cs.map(fn)), d);
    const pct503 = (c) => (100 * c.viajes.ubicacion_no_disponible_503) / Math.max(1, c.viajes.iteraciones);
    const lag = (c) => (c.viajes.servidor.lag_dispatch_s.p99 === '+Inf' ? Infinity : c.viajes.servidor.lag_dispatch_s.p99 * 1000);
    console.log(
      `| ${e} | ${cs.length} | ${m((c) => c.viajes.solicitudes_por_s, 2)} | ${m((c) => c.viajes.cliente_ms.crear.p50)} / ${m((c) => c.viajes.cliente_ms.crear.p95)} / ${m((c) => c.viajes.cliente_ms.crear.p99)} | ${m((c) => c.viajes.cliente_ms.hasta_asignacion.p50 ?? NaN)} / ${m((c) => c.viajes.cliente_ms.hasta_asignacion.p95 ?? NaN)} / ${m((c) => c.viajes.cliente_ms.hasta_asignacion.p99 ?? NaN)} | ${m(pct503, 1)} | ${m(lag)} | ${m((c) => c.cpuDispatchProm)} | ${m((c) => c.viajes.servidor.memoria_mb.dispatch.fin)} / ${m((c) => c.viajes.servidor.memoria_mb.location.fin)} |`,
    );
  }
}

// ===================== Estrés por escalones (escenario B: estres.ps1) =====================

const estres = readdirSync(carpeta, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith('estres-') && existsSync(join(carpeta, d.name, 'etapas-k6.json')))
  .map((d) => {
    const dir = join(carpeta, d.name);
    const k6 = JSON.parse(leer(join(dir, 'etapas-k6.json')));
    const srv = existsSync(join(dir, 'etapas-servidor.json')) ? JSON.parse(leer(join(dir, 'etapas-servidor.json'))) : { etapas: [] };
    const conteos = existsSync(join(dir, 'conteos.json')) ? JSON.parse(leer(join(dir, 'conteos.json'))) : {};
    const stats = leer(join(dir, 'docker-stats.csv')).split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(','));
    const etapas = k6.etapas.map((e) => {
      const s = srv.etapas.find((x) => x.etapa === e.etapa) ?? {};
      const desde = Date.parse(s.ventana_estable?.desde ?? 0);
      const hasta = Date.parse(s.ventana_estable?.hasta ?? 0);
      const cpu = (c) => {
        const xs = stats.filter((x) => x[1] === c && Date.parse(x[0]) >= desde && Date.parse(x[0]) <= hasta).map((x) => parseFloat(x[2]));
        return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
      };
      const base = Math.max(1, e.iniciados_ventana_estable);
      const criterios = {
        crear_p95: e.crear_ms.p95 !== null && e.crear_ms.p95 > 500,
        asignacion_p95: e.hasta_asignacion_ms.p95 !== null && e.hasta_asignacion_ms.p95 > 2000,
        errores: (e.errores + e.ubicacion_503) / base > 0.01,
        omitidos: e.omitidos_por_k6_etapa / Math.max(1, e.previstos_etapa) > 0.01,
        sin_resolver: (e.sin_resolver + e.sin_choferes) / base > 0.01,
      };
      return {
        ...e,
        servidor: s,
        cpuDispatch: cpu('viajes-carga-dispatch-1'),
        cpuPostgres: cpu('viajes-carga-postgres-1'),
        cpuLocation: cpu('viajes-carga-location-1'),
        criterios,
        degradada: Object.values(criterios).some(Boolean),
      };
    });
    return { nombre: d.name, etapas, conteos, primeraDegradada: etapas.find((e) => e.degradada) ?? null };
  })
  .sort((a, b) => a.nombre.localeCompare(b.nombre));

if (estres.length) {
  const n0 = (x) => (x === null || x === undefined ? '—' : Math.round(x));
  console.log('\n### Estrés por escalones (escenario B)\n');
  console.log('Ventana estable de cada escalón (sin la transición). Degradada si incumple cualquier criterio de docs/mediciones.md.\n');
  for (const c of estres) {
    const primera = c.primeraDegradada;
    const motivos = primera ? Object.entries(primera.criterios).filter(([, v]) => v).map(([k]) => k).join(', ') : '';
    console.log(`#### ${c.nombre}: primera etapa degradada: ${primera ? `${primera.tasa} viajes/s (${motivos})` : 'ninguna'}\n`);
    console.log('| Tasa (viajes/s) | Previstos (etapa / ventana) | Iniciados (ventana) | Omitidos por k6 (etapa) | Viajes/s | Asignados | Sin choferes | Sin resolver | 503 ubicación | Errores | Crear p50 / p95 / p99 (ms) | Asignación p50 / p95 / p99 (ms) | Asignación servidor p95 | Lag dispatch p99 | RSS dispatch / location (MB) | CPU dispatch / Postgres / location (%) | Pings a location: total / choferes de prueba (por s) | ¿Degradada? |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const e of c.etapas) {
      const s = e.servidor;
      console.log(
        `| ${e.tasa} | ${e.previstos_etapa} / ${e.previstos_ventana_estable} | ${e.iniciados_ventana_estable} | ${e.omitidos_por_k6_etapa} | ${e.viajes_por_s} | ${e.asignados} | ${e.sin_choferes} | ${e.sin_resolver} | ${e.ubicacion_503} | ${e.errores} | ${n0(e.crear_ms.p50)} / ${n0(e.crear_ms.p95)} / ${n0(e.crear_ms.p99)} | ${n0(e.hasta_asignacion_ms.p50)} / ${n0(e.hasta_asignacion_ms.p95)} / ${n0(e.hasta_asignacion_ms.p99)} | ${seg(s.hasta_asignacion_s?.p95)} | ${seg(s.lag_dispatch_s?.p99)} | ${s.memoria_mb?.dispatch ?? '—'} / ${s.memoria_mb?.location ?? '—'} | ${f(e.cpuDispatch, 0)} / ${f(e.cpuPostgres, 0)} / ${f(e.cpuLocation, 0)} | ${s.pings_location_por_s ?? '—'} / ${s.pings_choferes_prueba_por_s ?? '—'} | ${e.degradada ? 'sí' : 'no'} |`,
      );
    }
    const k = c.conteos.correccion ?? {};
    console.log(
      `\nCorrección: viajes activos al final ${k.viajes_activos ?? '—'}, ofertas a no aptos ${k.ofertas_a_no_aptos ?? '—'}, viajes de no aptos ${k.viajes_de_no_aptos ?? '—'}, fuera de Córdoba ${k.viajes_fuera_de_cordoba ?? '—'}, asignados sin flota ${k.asignados_sin_flota ?? '—'}. k6 terminó con ${c.conteos.codigo_k6 ?? '—'} (99: se incumplió algún criterio de degradación).\n`,
    );
  }
}
