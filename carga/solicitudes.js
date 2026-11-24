// Viajes en paralelo, de punta a punta, mientras k6 carga a location (escenario A de docs/mediciones.md).
// Lo corre carga/medir.ps1 -Solicitudes en un contenedor node:22-alpine, dentro de la red viajes-carga.
// No es k6 porque pasajeros y choferes se enteran de sus eventos por SSE (GET /eventos), y k6 no lee
// streams.
//
// - PASAJEROS pasajeros distintos (de tokens-viajes.json), en lazo cerrado, en paralelo:
//   crear el viaje → esperar TripAssigned o NoDriversFound en su SSE (hasta ESPERA_MS) → dejarlo
//   asignado 1 s → cancelar y confirmar por GET → 1 s → otra vez. Si la espera vence, se consulta el
//   estado y se cancela si sigue activo, ANTES de volver a usar al pasajero.
// - CHOFERES_APTOS choferes aptos y los 10 no aptos (carga/lib/choferes.mjs), cerca del origen, en
//   Córdoba: lejos de los 500 choferes de k6 (Buenos Aires), así compiten solo los de prueba.
// Las iteraciones corren solo durante la fase de MEDICIÓN de k6. Escribe /resultados/solicitudes.json
// (sin tokens) y fotos de /metrics de dispatch y de location al empezar y al terminar la ventana.
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as esperar } from 'node:timers/promises';
import { arrancarChoferes, conClave, escucharSse, pedir, ventanaPings } from './lib/choferes.mjs';
import { leerMetricas, memoriaMb, percentiles, serie, sumaSerie, ventanaHistograma } from './lib/metricas.mjs';

const DISPATCH = process.env.DISPATCH_URL ?? 'http://dispatch:3005';
const LOCATION = process.env.LOCATION_URL ?? 'http://location:3004';
const TOKEN_METRICAS = process.env.METRICAS_TOKEN;
const CALENTAMIENTO_S = Number(process.env.CALENTAMIENTO_S ?? 30);
const MEDICION_S = Number(process.env.MEDICION_S ?? 300);
const PASAJEROS = Number(process.env.PASAJEROS ?? 20);
const CHOFERES_APTOS = Number(process.env.CHOFERES_APTOS ?? 40);
const ESPERA_MS = Number(process.env.ESPERA_MS ?? 20_000);
const SALIDA = process.env.SALIDA ?? '/resultados';
// Márgenes para quedar dentro de la fase de medición aunque los contenedores arranquen con desfasaje.
const MARGEN_INICIO_MS = 2_000;
const MARGEN_FIN_MS = 5_000;
const ASIGNADO_MS = 1_000;
const PAUSA_MS = 1_000;

if (!TOKEN_METRICAS) throw new Error('falta METRICAS_TOKEN');
const viajes = JSON.parse(readFileSync('/secretos/tokens-viajes.json', 'utf8'));
const pasajeros = viajes.pasajeros.slice(0, PASAJEROS);
const choferes = [...viajes.choferes.filter((c) => c.tipo === 'apto').slice(0, CHOFERES_APTOS), ...viajes.choferes.filter((c) => c.tipo !== 'apto')];
if (pasajeros.length < PASAJEROS) throw new Error(`tokens-viajes.json tiene ${pasajeros.length} pasajeros, hacen falta ${PASAJEROS}`);

// Córdoba: la zona «Carga Córdoba» de flotas.sql. Los choferes, a menos de 2 km; los orígenes, a menos de 1 km.
const ORIGEN = { lat: -31.4201, lng: -64.1888 };
const DESTINO = { lat: -31.4135, lng: -64.1811 };
const origenDe = (n) => ({ lat: ORIGEN.lat + ((n % 9) - 4) * 0.002, lng: ORIGEN.lng + ((Math.floor(n / 9) % 9) - 4) * 0.002 });

const ahora = () => performance.now();
const iso = () => new Date().toISOString();
const log = (...partes) => console.log(`[${iso()}]`, ...partes);

/** k6 arrancó cuando los pings a location empiezan a subir (antes de que informen los choferes de prueba). */
async function esperarK6() {
  const pings = async () => serie(await leerMetricas(LOCATION, TOKEN_METRICAS), 'http_request_duration_seconds_count', 'ruta="/ubicaciones"') ?? 0;
  const inicial = await pings();
  const limite = ahora() + 120_000;
  while (ahora() < limite) {
    await esperar(200);
    if ((await pings()) > inicial) return;
  }
  throw new Error('k6 no empezó a mandar pings en 2 minutos');
}

// ---------- Un pasajero ----------

const ACTIVOS = new Set(['BUSCANDO', 'ASIGNADO', 'EN_CAMINO', 'EN_CURSO']);

function pasajero(p, indice, fin, global) {
  const eventos = new Map(); // solicitudId → { tipo, ms }
  const esperando = new Map(); // solicitudId → resolver
  let vivo = true;
  void escucharSse(
    DISPATCH,
    p.token,
    () => vivo,
    (tipo, datos) => {
      if (!['TripAssigned', 'NoDriversFound'].includes(tipo) || datos.pasajeroId !== p.id) return;
      const registro = { tipo, ms: ahora(), choferId: datos.choferId ?? null };
      eventos.set(datos.solicitudId, registro);
      esperando.get(datos.solicitudId)?.(registro);
    },
    { alError: (err) => log(`SSE del pasajero ${p.id.slice(-4)}: ${err}`) },
  );
  const esperarEvento = (solicitudId) =>
    eventos.get(solicitudId)
      ? Promise.resolve(eventos.get(solicitudId))
      : new Promise((resolver) => {
          const plazo = setTimeout(() => {
            esperando.delete(solicitudId);
            resolver(null);
          }, ESPERA_MS);
          esperando.set(solicitudId, (r) => {
            clearTimeout(plazo);
            esperando.delete(solicitudId);
            resolver(r);
          });
        });
  const contarReintento = () => (global.reintentos += 1);

  /** Cancela si sigue activa y lo confirma por GET. true si el pasajero quedó libre. */
  async function liberar(solicitudId) {
    const r = await pedir('GET', `${DISPATCH}/solicitudes/${solicitudId}`, p.token).catch(() => null);
    if (r?.estado === 200 && !ACTIVOS.has(r.json.estado)) return true;
    const c = await conClave('POST', `${DISPATCH}/solicitudes/${solicitudId}/cancelar`, p.token, {}, contarReintento);
    if (c.estado !== 200 && !(c.estado === 409 && c.json?.error?.code === 'TRANSICION_INVALIDA')) {
      global.errores[`cancelar_${c.estado}_${c.json?.error?.code ?? ''}`] = (global.errores[`cancelar_${c.estado}_${c.json?.error?.code ?? ''}`] ?? 0) + 1;
    }
    for (let i = 0; i < 50; i++) {
      const g = await pedir('GET', `${DISPATCH}/solicitudes/${solicitudId}`, p.token).catch(() => null);
      if (g?.estado === 200 && !ACTIVOS.has(g.json.estado)) return true;
      await esperar(100);
    }
    return false;
  }

  return (async () => {
    // Escalonados: los pasajeros no empiezan todos en el mismo milisegundo.
    await esperar(Math.floor((indice * 1000) / PASAJEROS));
    for (let n = 0; ahora() < fin; n++) {
      const fila = { pasajero: indice, inicio: iso() };
      const t0 = ahora();
      const creada = await conClave('POST', `${DISPATCH}/solicitudes`, p.token, { origen: origenDe(indice * 31 + n), destino: DESTINO }, contarReintento);
      fila.crearMs = Math.round(ahora() - t0);
      global.crear.push(fila.crearMs);
      if (creada.estado !== 201) {
        const codigo = creada.json?.error?.code ?? '';
        fila.resultado = creada.estado === 503 && codigo === 'UBICACION_NO_DISPONIBLE' ? 'ubicacion_no_disponible' : 'error';
        fila.motivo = `crear_${creada.estado}_${codigo}`;
        global.filas.push(fila);
        if (fila.resultado === 'error') global.errores[fila.motivo] = (global.errores[fila.motivo] ?? 0) + 1;
        await esperar(PAUSA_MS);
        continue;
      }
      const id = creada.json.id;
      fila.solicitudId = id;
      if (creada.json.estado === 'SIN_CHOFERES') {
        fila.resultado = 'sin_choferes';
        global.filas.push(fila);
        await esperar(PAUSA_MS);
        continue;
      }
      const evento = await esperarEvento(id);
      if (evento?.tipo === 'TripAssigned') {
        fila.resultado = 'asignada';
        fila.asignacionMs = Math.round(evento.ms - t0);
        global.asignacion.push(fila.asignacionMs);
        await esperar(ASIGNADO_MS);
      } else if (evento?.tipo === 'NoDriversFound') {
        fila.resultado = 'sin_choferes';
      } else {
        fila.resultado = 'timeout';
      }
      // Liberar antes de reusar al pasajero: cancelar si sigue activa (también tras un timeout).
      const libre = await liberar(id);
      fila.liberado = libre;
      global.filas.push(fila);
      if (!libre) {
        global.errores.no_se_pudo_liberar = (global.errores.no_se_pudo_liberar ?? 0) + 1;
        log(`pasajero ${indice}: el viaje ${id} no se pudo liberar; dejo de usarlo`);
        break;
      }
      await esperar(PAUSA_MS);
    }
    vivo = false;
  })();
}

// ---------- Principal ----------

async function main() {
  log('esperando a que k6 empiece…');
  await esperarK6();
  const k6Detectado = iso();
  const ch = arrancarChoferes({ dispatch: DISPATCH, location: LOCATION, choferes, origen: ORIGEN, log });
  log(`k6 detectado; ${choferes.length} choferes de prueba arrancados; espero ${CALENTAMIENTO_S} s (+${MARGEN_INICIO_MS / 1000} s)`);
  await esperar(CALENTAMIENTO_S * 1000 + MARGEN_INICIO_MS);

  const [dAntes, lAntes] = [await leerMetricas(DISPATCH, TOKEN_METRICAS), await leerMetricas(LOCATION, TOKEN_METRICAS)];
  writeFileSync(`${SALIDA}/metrics-dispatch-antes.txt`, dAntes);
  writeFileSync(`${SALIDA}/metrics-location-antes.txt`, lAntes);
  const pingsAntes = ch.fotoPings();
  const ventanaInicio = iso();
  const tInicio = ahora();
  const fin = tInicio + MEDICION_S * 1000 - MARGEN_INICIO_MS - MARGEN_FIN_MS;
  const global = { filas: [], crear: [], asignacion: [], errores: {}, reintentos: 0 };
  await Promise.all(pasajeros.map((p, i) => pasajero(p, i, fin, global)));
  const ventanaS = (ahora() - tInicio) / 1000;
  const ventanaFin = iso();
  const [dDespues, lDespues] = [await leerMetricas(DISPATCH, TOKEN_METRICAS), await leerMetricas(LOCATION, TOKEN_METRICAS)];
  writeFileSync(`${SALIDA}/metrics-dispatch.txt`, dDespues);
  writeFileSync(`${SALIDA}/metrics-location-despues.txt`, lDespues);
  const pingsDespues = ch.fotoPings();
  ch.parar();
  const pingsChoferes = ventanaPings(pingsAntes, pingsDespues, ventanaS);
  // Lo que location aceptó en la ventana: el fondo de k6 más los choferes de prueba.
  const deltaL = (...f) => sumaSerie(lDespues, 'http_request_duration_seconds_count', 'metodo="POST"', 'ruta="/ubicaciones"', ...f) - sumaSerie(lAntes, 'http_request_duration_seconds_count', 'metodo="POST"', 'ruta="/ubicaciones"', ...f);
  const location204 = deltaL('estado="204"');

  const contar = (r) => global.filas.filter((f) => f.resultado === r).length;
  const delta = (nombre, ...f) => sumaSerie(dDespues, nombre, ...f) - sumaSerie(dAntes, nombre, ...f);
  const iteraciones = global.filas.length;
  const resumen = {
    pasajeros: PASAJEROS,
    choferes: { aptos: CHOFERES_APTOS, no_aptos: choferes.length - CHOFERES_APTOS },
    k6Detectado,
    ventana: { inicio: ventanaInicio, fin: ventanaFin, segundos: Math.round(ventanaS), calentamiento_s: CALENTAMIENTO_S, medicion_s: MEDICION_S },
    iteraciones,
    // Intentos: cada POST /solicitudes. Creados: los que respondieron 201. Asignados: los que llegaron a TripAssigned.
    intentos: iteraciones,
    intentos_por_s: Number((iteraciones / ventanaS).toFixed(2)),
    creados: global.filas.filter((f) => f.solicitudId).length,
    creados_por_s: Number((global.filas.filter((f) => f.solicitudId).length / ventanaS).toFixed(2)),
    solicitudes_por_s: Number((iteraciones / ventanaS).toFixed(2)),
    asignadas: contar('asignada'),
    asignadas_por_s: Number((contar('asignada') / ventanaS).toFixed(2)),
    sin_choferes: contar('sin_choferes'),
    ubicacion_no_disponible_503: contar('ubicacion_no_disponible'),
    timeouts: contar('timeout'),
    errores: global.errores,
    errores_total: Object.values(global.errores).reduce((a, b) => a + b, 0),
    reintentos_cliente: global.reintentos,
    cliente_ms: { crear: percentiles(global.crear), hasta_asignacion: percentiles(global.asignacion) },
    servidor: {
      crear: ventanaHistograma(dAntes, dDespues, 'http_request_duration_seconds', 'metodo="POST"', 'ruta="/solicitudes"'),
      aceptar: ventanaHistograma(dAntes, dDespues, 'http_request_duration_seconds', 'metodo="POST"', 'ruta="/ofertas/:id/aceptar"'),
      hasta_asignacion_s: ventanaHistograma(dAntes, dDespues, 'dispatch_tiempo_hasta_asignacion_seconds'),
      busquedas_sin_aptos: {
        sin_candidatos: delta('dispatch_busquedas_sin_aptos_total', 'motivo="sin_candidatos"'),
        filtrados: delta('dispatch_busquedas_sin_aptos_total', 'motivo="filtrados"'),
        tope_agotado: delta('dispatch_busquedas_sin_aptos_total', 'motivo="tope_agotado"'),
      },
      ofertas_vencidas: delta('dispatch_ofertas_vencidas_total'),
      lag_dispatch_s: ventanaHistograma(dAntes, dDespues, 'event_loop_lag_seconds'),
      lag_location_s: ventanaHistograma(lAntes, lDespues, 'event_loop_lag_seconds'),
      memoria_mb: {
        dispatch: { inicio: memoriaMb(dAntes), fin: memoriaMb(dDespues) },
        location: { inicio: memoriaMb(lAntes), fin: memoriaMb(lDespues) },
      },
    },
    choferes_prueba: {
      ...ch.estadisticas,
      ventana: pingsChoferes,
      pings_en_la_ventana: pingsChoferes.enviados,
      pings_por_s_en_la_ventana: pingsChoferes.enviados_por_s,
    },
    location_pings_ventana: {
      aceptados_204: location204,
      otros_estados: deltaL() - location204,
      aceptados_por_s: Number((location204 / ventanaS).toFixed(1)),
      fondo_aceptados_por_s: Number(((location204 - pingsChoferes.aceptados_por_location) / ventanaS).toFixed(1)),
    },
  };
  writeFileSync(`${SALIDA}/solicitudes.json`, JSON.stringify({ resumen, filas: global.filas }, null, 2));
  log('resumen:', JSON.stringify(resumen));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
