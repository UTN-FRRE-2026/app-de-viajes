// Solicitud real de punta a punta mientras k6 carga a location (prueba piloto de latencia bajo carga).
// Lo corre carga/medir.ps1 -Solicitudes en un contenedor node:22-alpine, dentro de la red viajes-carga.
// No es k6 porque el chofer se entera de su oferta por SSE (GET /eventos), y k6 no lee streams.
//
// Cada iteración: el pasajero crea el viaje → el chofer recibe OfferCreated por SSE y acepta → GET
// confirma ASIGNADO → el pasajero cancela, lo que libera a los dos → GET confirma la cancelación.
// Las iteraciones corren solo durante la fase de MEDICIÓN de k6: se espera a ver los pings de k6 en
// location y el calentamiento. Escribe /resultados/solicitudes.json (sin tokens) y dos fotos de
// /metrics de dispatch, de antes y después de la ventana.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as esperar } from 'node:timers/promises';

const DISPATCH = process.env.DISPATCH_URL ?? 'http://dispatch:3005';
const LOCATION = process.env.LOCATION_URL ?? 'http://location:3004';
const TOKEN_METRICAS = process.env.METRICAS_TOKEN;
const CALENTAMIENTO_S = Number(process.env.CALENTAMIENTO_S ?? 30);
const MEDICION_S = Number(process.env.MEDICION_S ?? 300);
const SALIDA = process.env.SALIDA ?? '/resultados';
const TIMEOUT_OFERTA_MS = 20_000;
// Márgenes para quedar dentro de la fase de medición aunque los contenedores arranquen con desfasaje.
const MARGEN_INICIO_MS = 2_000;
const MARGEN_FIN_MS = 5_000;

if (!TOKEN_METRICAS) throw new Error('falta METRICAS_TOKEN');
const { pasajeroId, pasajero, choferId, chofer } = JSON.parse(readFileSync('/secretos/tokens-solicitudes.json', 'utf8'));

// Lejos de la nube de los 500 choferes de k6 (Buenos Aires): ninguno de ellos es candidato acá, así la
// oferta le llega siempre al chofer del flujo.
const ORIGEN = { lat: -31.4201, lng: -64.1888 }; // Córdoba
const DESTINO = { lat: -31.4135, lng: -64.1811 };

const ahora = () => performance.now();
const iso = () => new Date().toISOString();
const log = (...partes) => console.log(`[${iso()}]`, ...partes);

// ---------- HTTP ----------

async function pedir(metodo, url, token, cuerpo, clave) {
  const encabezados = { authorization: `Bearer ${token}` };
  if (cuerpo !== undefined) encabezados['content-type'] = 'application/json';
  if (clave) encabezados['idempotency-key'] = clave;
  const res = await fetch(url, { method: metodo, headers: encabezados, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const texto = await res.text();
  let json = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    json = null;
  }
  return { estado: res.status, json, repetida: res.headers.get('idempotent-replayed') === 'true' };
}

/**
 * Una operación con efecto, con su Idempotency-Key. Ante un error de red, un 5xx o un 409 «clave en
 * curso», reintenta CON LA MISMA CLAVE (hasta 3 reintentos): si el primer intento sí tuvo efecto,
 * dispatch devuelve la respuesta guardada en vez de repetirlo.
 */
async function conClave(metodo, url, token, cuerpo, estadisticas) {
  const clave = randomUUID();
  let ultimo;
  for (let intento = 0; intento <= 3; intento++) {
    if (intento > 0) {
      estadisticas.reintentos += 1;
      await esperar(200 * intento);
    }
    try {
      ultimo = await pedir(metodo, url, token, cuerpo, clave);
    } catch (err) {
      ultimo = { estado: 0, json: { error: { code: 'RED', message: String(err) } }, repetida: false };
      continue;
    }
    const enCurso = ultimo.estado === 409 && ultimo.json?.error?.code === 'CLAVE_IDEMPOTENCIA_EN_CURSO';
    if (ultimo.estado >= 500 || enCurso) continue;
    return ultimo;
  }
  return ultimo;
}

async function leerMetricas(base) {
  const res = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN_METRICAS}` } });
  if (!res.ok) throw new Error(`/metrics de ${base} respondió ${res.status}`);
  return res.text();
}

/** Valor de una serie de Prometheus (con o sin etiquetas que contengan `contiene`). */
function serie(texto, nombre, contiene = '') {
  for (const linea of texto.split('\n')) {
    if (!linea.startsWith(nombre)) continue;
    const resto = linea.slice(nombre.length);
    if (resto[0] !== '{' && resto[0] !== ' ') continue;
    if (contiene && !resto.includes(contiene)) continue;
    return Number(linea.trim().split(/\s+/).pop());
  }
  return null;
}

/** Cubetas acumuladas de un histograma: [{ le, cuenta }] ordenadas. */
function cubetas(texto, nombre) {
  const filas = [];
  for (const linea of texto.split('\n')) {
    if (!linea.startsWith(`${nombre}_bucket{`)) continue;
    const le = linea.match(/le="([^"]+)"/)?.[1];
    filas.push({ le: le === '+Inf' ? Infinity : Number(le), cuenta: Number(linea.trim().split(/\s+/).pop()) });
  }
  return filas.sort((a, b) => a.le - b.le);
}

/** Cuantil aproximado de la diferencia entre dos fotos del histograma: el borde superior de la cubeta. */
function cuantilDiferencia(antes, despues, q) {
  const a = new Map(antes.map((c) => [c.le, c.cuenta]));
  const dif = despues.map((c) => ({ le: c.le, cuenta: c.cuenta - (a.get(c.le) ?? 0) }));
  const total = dif.at(-1)?.cuenta ?? 0;
  if (total === 0) return null;
  const objetivo = q * total;
  return dif.find((c) => c.cuenta >= objetivo)?.le ?? null;
}

const percentil = (valores, q) => {
  if (valores.length === 0) return null;
  const ordenados = [...valores].sort((x, y) => x - y);
  return Math.round(ordenados[Math.min(ordenados.length - 1, Math.ceil(q * ordenados.length) - 1)]);
};

// ---------- SSE del chofer ----------

/**
 * Las ofertas que llegan por SSE, guardadas por solicitudId. Pueden llegar ANTES de que el pasajero
 * reciba el 201 (el relay publica apenas confirma): por eso se guardan todas y se cruzan después por id.
 */
const ofertas = new Map(); // solicitudId → { ofertaId, llegadaMs }
const esperando = new Map(); // solicitudId → resolver
let sseVivo = true;

async function escucharOfertas() {
  let ultimoId = null;
  while (sseVivo) {
    try {
      const encabezados = { authorization: `Bearer ${chofer}`, accept: 'text/event-stream' };
      if (ultimoId) encabezados['last-event-id'] = ultimoId;
      const res = await fetch(`${DISPATCH}/eventos`, { headers: encabezados });
      if (!res.ok || !res.body) throw new Error(`/eventos respondió ${res.status}`);
      const lector = res.body.getReader();
      const decodificador = new TextDecoder();
      let pendiente = '';
      while (sseVivo) {
        const { value, done } = await lector.read();
        if (done) break;
        pendiente += decodificador.decode(value, { stream: true });
        let corte;
        while ((corte = pendiente.indexOf('\n\n')) >= 0) {
          const bloque = pendiente.slice(0, corte);
          pendiente = pendiente.slice(corte + 2);
          let evento = '';
          let datos = '';
          for (const linea of bloque.split('\n')) {
            if (linea.startsWith('event:')) evento = linea.slice(6).trim();
            else if (linea.startsWith('data:')) datos += linea.slice(5).trim();
            else if (linea.startsWith('id:')) ultimoId = linea.slice(3).trim();
          }
          if (evento !== 'OfferCreated' || !datos) continue;
          const oferta = JSON.parse(datos);
          if (oferta.choferId !== choferId) continue;
          const registro = { ofertaId: oferta.ofertaId, llegadaMs: ahora() };
          ofertas.set(oferta.solicitudId, registro);
          esperando.get(oferta.solicitudId)?.(registro);
        }
      }
    } catch (err) {
      if (sseVivo) log('SSE del chofer:', String(err), '— reconecto');
    }
    if (sseVivo) await esperar(500);
  }
}

function esperarOferta(solicitudId, timeoutMs) {
  const ya = ofertas.get(solicitudId);
  if (ya) return Promise.resolve(ya);
  return new Promise((resolver) => {
    const plazo = setTimeout(() => {
      esperando.delete(solicitudId);
      resolver(null);
    }, timeoutMs);
    esperando.set(solicitudId, (registro) => {
      clearTimeout(plazo);
      esperando.delete(solicitudId);
      resolver(registro);
    });
  });
}

// ---------- Ventana: la fase de medición de k6 ----------

/** k6 arrancó cuando los pings a location empiezan a subir (el chofer del flujo todavía no informa). */
async function esperarK6() {
  const pings = async () => serie(await leerMetricas(LOCATION), 'http_request_duration_seconds_count', 'ruta="/ubicaciones"') ?? 0;
  const inicial = await pings();
  const limite = ahora() + 120_000;
  while (ahora() < limite) {
    await esperar(200);
    if ((await pings()) > inicial) return;
  }
  throw new Error('k6 no empezó a mandar pings en 2 minutos');
}

/** El chofer del flujo tiene que estar vigente en location (30 s): informa su posición cada 2 s. */
function mantenerChoferVigente() {
  let vivo = true;
  const ciclo = async () => {
    while (vivo) {
      await pedir('POST', `${LOCATION}/ubicaciones`, chofer, ORIGEN).catch(() => {});
      await esperar(2000);
    }
  };
  void ciclo();
  return () => {
    vivo = false;
  };
}

// ---------- Una iteración ----------

async function esperarEstado(solicitudId, estado, timeoutMs) {
  const limite = ahora() + timeoutMs;
  for (;;) {
    const r = await pedir('GET', `${DISPATCH}/solicitudes/${solicitudId}`, pasajero);
    if (r.estado === 200 && r.json?.estado === estado) return r.json;
    if (ahora() >= limite) return r.json;
    await esperar(100);
  }
}

async function iteracion(n, estadisticas) {
  const fila = { n, inicio: iso(), resultado: null };
  const t0 = ahora();
  const creada = await conClave('POST', `${DISPATCH}/solicitudes`, pasajero, { origen: ORIGEN, destino: DESTINO }, estadisticas);
  const t201 = ahora();
  fila.crear = { estado: creada.estado, repetida: creada.repetida, ms: Math.round(t201 - t0) };
  if (creada.estado !== 201) {
    fila.resultado = 'sin_asignar';
    fila.motivo = `crear_${creada.estado}_${creada.json?.error?.code ?? ''}`;
    return fila;
  }
  const solicitudId = creada.json.id;
  fila.solicitudId = solicitudId;
  if (creada.json.estado === 'SIN_CHOFERES') {
    fila.resultado = 'sin_asignar';
    fila.motivo = 'SIN_CHOFERES';
    return fila;
  }

  const oferta = await esperarOferta(solicitudId, TIMEOUT_OFERTA_MS);
  if (!oferta) {
    fila.resultado = 'sin_asignar';
    fila.motivo = 'sin_oferta_en_20_s';
    return fila;
  }
  fila.oferta = { antesDel201: oferta.llegadaMs < t201, msDesdeInicio: Math.round(oferta.llegadaMs - t0) };

  const aceptada = await conClave('POST', `${DISPATCH}/ofertas/${oferta.ofertaId}/aceptar`, chofer, {}, estadisticas);
  const tAceptada = ahora();
  fila.aceptar = { estado: aceptada.estado, repetida: aceptada.repetida };
  if (aceptada.estado !== 200) {
    fila.resultado = 'sin_asignar';
    fila.motivo = `aceptar_${aceptada.estado}_${aceptada.json?.error?.code ?? ''}`;
    return fila;
  }
  fila.msHastaAsignacion = Math.round(tAceptada - t0);

  // Confirmar por GET que quedó asignado a este chofer.
  const asignada = await esperarEstado(solicitudId, 'ASIGNADO', 5000);
  fila.confirmadaPorGet = asignada?.estado === 'ASIGNADO' && asignada?.choferId === choferId;
  fila.msHastaConfirmada = Math.round(ahora() - t0);

  // Liberar a los dos: el pasajero cancela (borra la reserva del chofer y su solicitud activa en la
  // misma transacción). Se confirma por GET antes de seguir.
  const cancelada = await conClave('POST', `${DISPATCH}/solicitudes/${solicitudId}/cancelar`, pasajero, {}, estadisticas);
  const final = await esperarEstado(solicitudId, 'CANCELADO_PASAJERO', 5000);
  fila.cancelar = { estado: cancelada.estado, confirmadaPorGet: final?.estado === 'CANCELADO_PASAJERO' };
  fila.resultado = fila.confirmadaPorGet ? 'asignada' : 'sin_confirmar';
  return fila;
}

// ---------- Principal ----------

async function main() {
  void escucharOfertas();
  log('esperando a que k6 empiece…');
  await esperarK6();
  const k6Detectado = iso();
  const pararPings = mantenerChoferVigente();
  log(`k6 detectado; espero ${CALENTAMIENTO_S} s de calentamiento (+${MARGEN_INICIO_MS / 1000} s de margen)`);
  await esperar(CALENTAMIENTO_S * 1000 + MARGEN_INICIO_MS);

  const metricasAntes = await leerMetricas(DISPATCH);
  writeFileSync(`${SALIDA}/metrics-dispatch-antes.txt`, metricasAntes);
  const ventanaInicio = iso();
  const finMs = ahora() + MEDICION_S * 1000 - MARGEN_INICIO_MS - MARGEN_FIN_MS;
  const estadisticas = { reintentos: 0 };
  const filas = [];
  for (let n = 1; ahora() < finMs; n++) {
    const fila = await iteracion(n, estadisticas);
    filas.push(fila);
    log(`#${n} ${fila.resultado}${fila.motivo ? ` (${fila.motivo})` : ''}${fila.msHastaAsignacion ? ` ${fila.msHastaAsignacion} ms` : ''}`);
    // No se empieza otra con la anterior sin cancelar: el pasajero y el chofer tienen que estar libres.
    if (fila.cancelar && !fila.cancelar.confirmadaPorGet) {
      log('la cancelación no se confirmó: corto para no medir con participantes ocupados');
      break;
    }
    await esperar(1000);
  }
  const ventanaFin = iso();
  const metricasDespues = await leerMetricas(DISPATCH);
  writeFileSync(`${SALIDA}/metrics-dispatch.txt`, metricasDespues);
  pararPings();
  sseVivo = false;

  const HIST = 'dispatch_tiempo_hasta_asignacion_seconds';
  const cuentaHist = (t) => serie(t, `${HIST}_count`) ?? 0;
  const asignadas = filas.filter((f) => f.resultado === 'asignada');
  const tiempos = asignadas.map((f) => f.msHastaAsignacion);
  const deltaHistograma = cuentaHist(metricasDespues) - cuentaHist(metricasAntes);
  const sinChoferes = (t) => serie(t, 'dispatch_solicitudes_total', 'resultado="sin_choferes"') ?? 0;
  const vencidas = (t) => serie(t, 'dispatch_ofertas_vencidas_total') ?? 0;
  const lag = (q) => serie(metricasDespues, 'event_loop_lag_ms', `quantile="${q}"`);

  const resumen = {
    pasajeroId,
    choferId,
    k6Detectado,
    ventana: { inicio: ventanaInicio, fin: ventanaFin, calentamiento_s: CALENTAMIENTO_S, medicion_s: MEDICION_S },
    iteraciones: filas.length,
    asignadas_confirmadas_por_get: asignadas.length,
    sin_asignar: filas.filter((f) => f.resultado !== 'asignada').length,
    motivos_sin_asignar: Object.fromEntries(
      Object.entries(
        filas.filter((f) => f.resultado !== 'asignada').reduce((m, f) => ({ ...m, [f.motivo ?? f.resultado]: (m[f.motivo ?? f.resultado] ?? 0) + 1 }), {}),
      ),
    ),
    ofertas_antes_del_201: filas.filter((f) => f.oferta?.antesDel201).length,
    cancelaciones_confirmadas: filas.filter((f) => f.cancelar?.confirmadaPorGet).length,
    reintentos: estadisticas.reintentos,
    cliente_ms_hasta_asignacion: { p50: percentil(tiempos, 0.5), p95: percentil(tiempos, 0.95), max: tiempos.length ? Math.max(...tiempos) : null },
    servidor_histograma: {
      incremento_count: deltaHistograma,
      coincide_con_get: deltaHistograma === asignadas.length,
      p50_s_cubeta: cuantilDiferencia(cubetas(metricasAntes, HIST), cubetas(metricasDespues, HIST), 0.5),
      p95_s_cubeta: cuantilDiferencia(cubetas(metricasAntes, HIST), cubetas(metricasDespues, HIST), 0.95),
    },
    dispatch_sin_choferes_incremento: sinChoferes(metricasDespues) - sinChoferes(metricasAntes),
    dispatch_ofertas_vencidas_incremento: vencidas(metricasDespues) - vencidas(metricasAntes),
    dispatch_lag_ms_desde_arranque: {
      p50: lag('0.5'),
      p99: lag('0.99'),
      max: serie(metricasDespues, 'event_loop_lag_max_ms'),
    },
  };
  writeFileSync(`${SALIDA}/solicitudes.json`, JSON.stringify({ resumen, filas }, null, 2));
  log('resumen:', JSON.stringify(resumen));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
