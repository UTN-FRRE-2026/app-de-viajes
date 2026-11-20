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
const metrica = (texto, nombre) => Number(texto.match(new RegExp(`^${nombre.replace(/[{}"=.]/g, '\\$&')} ([\\d.]+)`, 'm'))?.[1] ?? NaN);
const mb = (s) => {
  const [n, u] = [parseFloat(s), s.replace(/[\d.\s]/g, '')];
  return u.startsWith('GiB') ? n * 1024 : u.startsWith('KiB') ? n / 1024 : n;
};

const corridas = readdirSync(carpeta, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(carpeta, d.name, 'conteos.json')))
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
      lagP99: metrica(metricas, 'location_event_loop_lag_ms{quantile="0.99"}'),
      lagMax: metrica(metricas, 'location_event_loop_lag_max_ms'),
      rssMb: metrica(metricas, 'process_resident_memory_bytes') / 1048576,
      memLocationMb: memLocation,
      cpuLocationProm: prom(de('viajes-carga-location-1').map((s) => parseFloat(s[2]))),
      cpuLocationMax: maxCpu('viajes-carga-location-1'),
      cpuPostgresProm: prom(de('viajes-carga-postgres-1').map((s) => parseFloat(s[2]))),
      cpuRedisProm: prom(de('viajes-carga-redis-1').map((s) => parseFloat(s[2]))),
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
