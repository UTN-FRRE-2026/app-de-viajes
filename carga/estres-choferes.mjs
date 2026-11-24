// Compañero de carga/estres.js (escenario B): los choferes de prueba que aceptan los viajes (Node, por el
// SSE) y las fotos de /metrics de dispatch y de location en la ventana estable de cada escalón.
// Lo corre carga/estres.ps1 en un contenedor node:22-alpine, dentro de la red viajes-carga.
//
// El reloj de la rampa arranca con el primer POST /solicitudes de k6 (el calentamiento manda 1/s desde
// el segundo 0): se detecta mirando /metrics de dispatch cada 100 ms. Con el mismo plan que estres.js
// (CALENTAMIENTO_S, ETAPAS, ETAPA_S, TRANSICION_S), cada escalón tiene su ventana estable
// [inicio + TRANSICION_S, fin): ahí se toman las dos fotos. Escribe /resultados/etapas-servidor.json y
// /resultados/choferes.json, sin tokens, y las fotos en /resultados/metrics/.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as esperar } from 'node:timers/promises';
import { arrancarChoferes, ventanaPings } from './lib/choferes.mjs';
import { leerMetricas, memoriaMb, sumaSerie, ventanaHistograma } from './lib/metricas.mjs';

const DISPATCH = process.env.DISPATCH_URL ?? 'http://dispatch:3005';
const LOCATION = process.env.LOCATION_URL ?? 'http://location:3004';
const TOKEN_METRICAS = process.env.METRICAS_TOKEN;
const CALENTAMIENTO_S = Number(process.env.CALENTAMIENTO_S ?? 30);
const ETAPA_S = Number(process.env.ETAPA_S ?? 60);
const TRANSICION_S = Number(process.env.TRANSICION_S ?? 15);
const ETAPAS = (process.env.ETAPAS ?? '1,2,4,8,16,32').split(',').map(Number);
const CHOFERES_APTOS = Number(process.env.CHOFERES_APTOS ?? 300);
const SALIDA = process.env.SALIDA ?? '/resultados';
if (!TOKEN_METRICAS) throw new Error('falta METRICAS_TOKEN');

// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- los tokens se leen de un archivo montado; no hay ningún secreto en el código.
const viajes = JSON.parse(readFileSync('/secretos/tokens-viajes.json', 'utf8'));
const choferes = [...viajes.choferes.filter((c) => c.tipo === 'apto').slice(0, CHOFERES_APTOS), ...viajes.choferes.filter((c) => c.tipo !== 'apto')];
const ORIGEN = { lat: -31.4201, lng: -64.1888 };
const log = (...partes) => console.log(`[${new Date().toISOString()}]`, ...partes);

const fotos = async () => [await leerMetricas(DISPATCH, TOKEN_METRICAS), await leerMetricas(LOCATION, TOKEN_METRICAS)];
const creaciones = (t) => sumaSerie(t, 'http_request_duration_seconds_count', 'metodo="POST"', 'ruta="/solicitudes"');

async function main() {
  mkdirSync(`${SALIDA}/metrics`, { recursive: true });
  const ch = arrancarChoferes({ dispatch: DISPATCH, location: LOCATION, choferes, origen: ORIGEN, log });
  log(`${choferes.length} choferes de prueba arrancados; espero el primer POST /solicitudes de k6`);

  const inicial = creaciones(await leerMetricas(DISPATCH, TOKEN_METRICAS));
  const limite = Date.now() + 180_000;
  while (creaciones(await leerMetricas(DISPATCH, TOKEN_METRICAS)) === inicial) {
    if (Date.now() > limite) throw new Error('k6 no empezó a crear viajes en 3 minutos');
    await esperar(100);
  }
  const t0 = Date.now();
  log('k6 detectado: arranca el reloj de la rampa');

  const etapas = [];
  for (const [i, tasa] of ETAPAS.entries()) {
    const inicio = t0 + (CALENTAMIENTO_S + i * ETAPA_S) * 1000;
    const desde = inicio + TRANSICION_S * 1000;
    const hasta = inicio + ETAPA_S * 1000;
    await esperar(Math.max(0, desde - Date.now()));
    const [dA, lA] = await fotos();
    const pingsAntes = ch.fotoPings();
    const desdeIso = new Date().toISOString();
    await esperar(Math.max(0, hasta - Date.now()));
    const [dD, lD] = await fotos();
    const hastaIso = new Date().toISOString();
    const pingsDespues = ch.fotoPings();
    const segundos = (Date.parse(hastaIso) - Date.parse(desdeIso)) / 1000;
    for (const [nombre, texto] of [
      [`dispatch-etapa-${i + 1}-inicio`, dA],
      [`dispatch-etapa-${i + 1}-fin`, dD],
      [`location-etapa-${i + 1}-inicio`, lA],
      [`location-etapa-${i + 1}-fin`, lD],
    ]) {
      writeFileSync(`${SALIDA}/metrics/${nombre}.txt`, texto);
    }
    const delta = (nombre, ...f) => sumaSerie(dD, nombre, ...f) - sumaSerie(dA, nombre, ...f);
    const deltaL = (...f) =>
      sumaSerie(lD, 'http_request_duration_seconds_count', 'ruta="/ubicaciones"', 'metodo="POST"', ...f) -
      sumaSerie(lA, 'http_request_duration_seconds_count', 'ruta="/ubicaciones"', 'metodo="POST"', ...f);
    const etapa = {
      etapa: i + 1,
      tasa,
      ventana_estable: { desde: desdeIso, hasta: hastaIso, segundos },
      crear_s: ventanaHistograma(dA, dD, 'http_request_duration_seconds', 'metodo="POST"', 'ruta="/solicitudes"'),
      aceptar_s: ventanaHistograma(dA, dD, 'http_request_duration_seconds', 'metodo="POST"', 'ruta="/ofertas/:id/aceptar"'),
      hasta_asignacion_s: ventanaHistograma(dA, dD, 'dispatch_tiempo_hasta_asignacion_seconds'),
      lag_dispatch_s: ventanaHistograma(dA, dD, 'event_loop_lag_seconds'),
      lag_location_s: ventanaHistograma(lA, lD, 'event_loop_lag_seconds'),
      memoria_mb: { dispatch: memoriaMb(dD), location: memoriaMb(lD) },
      busquedas_sin_aptos: {
        sin_candidatos: delta('dispatch_busquedas_sin_aptos_total', 'motivo="sin_candidatos"'),
        filtrados: delta('dispatch_busquedas_sin_aptos_total', 'motivo="filtrados"'),
        tope_agotado: delta('dispatch_busquedas_sin_aptos_total', 'motivo="tope_agotado"'),
      },
      // Pings de location en la ventana: todos los que recibió (fondo + choferes de prueba), los que
      // aceptó (204), y los de los choferes de prueba (enviados y aceptados, y cuántos choferes).
      pings_location_por_s: Number((deltaL() / segundos).toFixed(1)),
      pings_location_aceptados_por_s: Number((deltaL('estado="204"') / segundos).toFixed(1)),
      pings_choferes_prueba_por_s: ventanaPings(pingsAntes, pingsDespues, segundos).enviados_por_s,
      choferes_prueba: ventanaPings(pingsAntes, pingsDespues, segundos),
      pings_fondo_aceptados_por_s: Number(
        ((deltaL('estado="204"') - ventanaPings(pingsAntes, pingsDespues, segundos).aceptados_por_location) / segundos).toFixed(1),
      ),
    };
    etapas.push(etapa);
    log(`etapa ${i + 1} (${tasa}/s): crear p95 ${etapa.crear_s.p95} s, lag dispatch p99 ${etapa.lag_dispatch_s.p99} s`);
  }
  // Los viajes que quedaron en vuelo terminan dentro del gracefulStop del último escalón de k6 (40 s).
  await esperar(45_000);
  ch.parar();
  writeFileSync(`${SALIDA}/etapas-servidor.json`, JSON.stringify({ calentamiento_s: CALENTAMIENTO_S, etapa_s: ETAPA_S, transicion_s: TRANSICION_S, etapas }, null, 2));
  writeFileSync(`${SALIDA}/choferes.json`, JSON.stringify(ch.estadisticas, null, 2));
  log('choferes:', JSON.stringify(ch.estadisticas));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
