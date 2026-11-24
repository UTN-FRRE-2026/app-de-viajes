// Choferes de prueba para los viajes en paralelo (carga/solicitudes.js y carga/estres.js). Node y no k6:
// el chofer se entera de su oferta por SSE (GET /eventos), y k6 no lee streams. Sin dependencias.
//
// Cada chofer:
// - informa su posición cada `pingCadaMs` (2 s, como los 500 choferes de k6 y como el mínimo entre
//   envíos de la pantalla del chofer), en un lugar fijo y determinista cerca del origen de los viajes.
//   A tasa fija, sin esperar la respuesta (modelo abierto, como k6), y con las fases repartidas en
//   todo el intervalo: no salen en ráfagas;
// - escucha su SSE y, si está libre, acepta enseguida la primera oferta (sin tiempo de reacción humano:
//   se mide el sistema). Con la misma Idempotency-Key si hay que reintentar. Las ofertas que le llegan
//   mientras acepta otra quedan en espera: si pierde la que estaba aceptando (409), prueba la siguiente
//   que siga vigente, como haría una persona que ve varias ofertas en la pantalla. Las que le llegan
//   con un viaje ya tomado se ignoran (se cuentan) y vencen solas;
// - queda ocupado hasta que su viaje se cancela o termina (RideCancelled o RideCompleted), y si ese
//   evento no llega en 60 s, lo confirma con GET /chofer/estado.
// Los choferes no aptos (tipo distinto de 'apto') hacen lo mismo: si alguno recibe una oferta, el
// sistema se equivocó, y queda contado.
import { randomUUID } from 'node:crypto';
import { setTimeout as esperar } from 'node:timers/promises';

const METROS_POR_GRADO = 111_195;

/** Un lugar determinista para el chofer `i`: espiral de Fermat dentro de `radioM` alrededor de `origen`. */
export function posicionDe(i, total, origen, radioM) {
  const angulo = i * 2.399963229728653; // ángulo áureo
  const metros = radioM * Math.sqrt((i + 0.5) / total);
  return {
    lat: origen.lat + (metros * Math.cos(angulo)) / METROS_POR_GRADO,
    lng: origen.lng + (metros * Math.sin(angulo)) / (METROS_POR_GRADO * Math.cos((origen.lat * Math.PI) / 180)),
  };
}

export async function pedir(metodo, url, token, cuerpo, clave) {
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
 * Una operación con efecto y su Idempotency-Key. Ante un error de red, un 5xx o un 409 «clave en curso»,
 * reintenta CON LA MISMA CLAVE, hasta 3 veces: si el primer intento tuvo efecto, dispatch repite su
 * respuesta en vez de aplicarlo de nuevo. Un 503 UBICACION_NO_DISPONIBLE no se reintenta: es la falla
 * cerrada de dispatch cuando location no responde a tiempo, y es lo que se mide.
 */
export async function conClave(metodo, url, token, cuerpo, contar = () => {}) {
  const clave = randomUUID();
  let ultimo;
  for (let intento = 0; intento <= 3; intento++) {
    if (intento > 0) {
      contar();
      await esperar(200 * intento);
    }
    try {
      ultimo = await pedir(metodo, url, token, cuerpo, clave);
    } catch (err) {
      ultimo = { estado: 0, json: { error: { code: 'RED', message: String(err) } }, repetida: false };
      continue;
    }
    const enCurso = ultimo.estado === 409 && ultimo.json?.error?.code === 'CLAVE_IDEMPOTENCIA_EN_CURSO';
    // 503 UBICACION_NO_DISPONIBLE es una respuesta definitiva: dispatch falla cerrado a propósito.
    const definitivo = ultimo.estado === 503 && ultimo.json?.error?.code === 'UBICACION_NO_DISPONIBLE';
    if ((ultimo.estado >= 500 && !definitivo) || enCurso) continue;
    return ultimo;
  }
  return ultimo;
}

/**
 * Lee un SSE de dispatch y llama a `alEvento(tipo, datos)`. Reconecta mientras `vivo()` sea true, con
 * Last-Event-ID. `alConectar` se llama cada vez que el stream queda abierto.
 */
export async function escucharSse(base, token, vivo, alEvento, { alConectar = () => {}, alError = () => {} } = {}) {
  let ultimoId = null;
  while (vivo()) {
    try {
      const encabezados = { authorization: `Bearer ${token}`, accept: 'text/event-stream' };
      if (ultimoId) encabezados['last-event-id'] = ultimoId;
      const res = await fetch(`${base}/eventos`, { headers: encabezados });
      if (!res.ok || !res.body) throw new Error(`/eventos respondió ${res.status}`);
      alConectar();
      const lector = res.body.getReader();
      const decodificador = new TextDecoder();
      let pendiente = '';
      while (vivo()) {
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
          if (!evento || !datos) continue;
          try {
            alEvento(evento, JSON.parse(datos));
          } catch {
            // un evento que no es JSON no le interesa a nadie acá
          }
        }
      }
      lector.cancel().catch(() => {});
    } catch (err) {
      if (vivo()) alError(err);
    }
    if (vivo()) await esperar(500);
  }
}

/** Los pings de los choferes de prueba entre dos `fotoPings()`. */
export function ventanaPings(antes, despues, segundos) {
  const enviados = despues.enviados - antes.enviados;
  const ok = despues.ok - antes.ok;
  return {
    segundos,
    enviados,
    aceptados_por_location: ok,
    fallidos: despues.fallidos - antes.fallidos,
    enviados_por_s: Number((enviados / segundos).toFixed(1)),
    aceptados_por_s: Number((ok / segundos).toFixed(1)),
    choferes_activos: despues.porChofer.filter((n, i) => n > antes.porChofer[i]).length,
  };
}

/**
 * Arranca los choferes. Devuelve `{ estadisticas, fotoPings, parar, conectados }`.
 * - `choferes`: [{ id, token, tipo }] (de tokens-viajes.json).
 * - `estadisticas`: contadores totales, por tipo de chofer, sin tokens.
 */
export function arrancarChoferes({ dispatch, location, choferes, origen, radioM = 2000, pingCadaMs = 2_000, log = () => {} }) {
  let vivo = true;
  const estadisticas = {
    choferes: choferes.length,
    ping_cada_ms: pingCadaMs,
    pings_enviados: 0,
    pings_ok: 0,
    pings_fallidos: 0,
    pings_en_vuelo: 0,
    ofertas_recibidas: 0,
    ofertas_a_no_aptos: 0,
    ofertas_ignoradas_ocupado: 0,
    ofertas_en_espera_probadas: 0,
    aceptadas_200: 0,
    aceptadas_por_no_aptos: 0,
    rechazos_409_esperados: {},
    aceptar_errores: {},
    reintentos: 0,
    liberados_por_evento: 0,
    liberados_por_consulta: 0,
    sse_reconexiones: 0,
  };
  let conectados = 0;
  const sumar = (mapa, clave) => (mapa[clave] = (mapa[clave] ?? 0) + 1);
  // Pings aceptados (204) por chofer: para contar cuántos estuvieron activos en una ventana.
  const okPorChofer = choferes.map(() => 0);

  const uno = (chofer, i) => {
    const posicion = posicionDe(i, choferes.length, origen, radioM);
    let ocupadoCon = null; // solicitudId del viaje que tiene, o 'aceptando'
    let ocupadoDesde = 0;
    // Viajes suyos que ya terminaron: el evento puede llegar antes que el 200 de su aceptación.
    const terminados = new Set();
    // Ofertas que llegaron mientras aceptaba otra: se prueban si pierde esa.
    let enEspera = [];
    const siguienteVigente = () => {
      enEspera = enEspera.filter((o) => Date.parse(o.venceEn) - Date.now() > 300);
      return enEspera.shift() ?? null;
    };

    // Posición: a tasa fija cada pingCadaMs, con la fase del chofer `i` en i/n del intervalo. El
    // siguiente sale a su hora aunque el anterior no haya respondido (un teléfono no espera a location).
    void (async () => {
      const inicio = Date.now() + Math.floor((i * pingCadaMs) / choferes.length);
      for (let k = 0; vivo; k++) {
        await esperar(Math.max(0, inicio + k * pingCadaMs - Date.now()));
        if (!vivo) break;
        estadisticas.pings_enviados += 1;
        estadisticas.pings_en_vuelo += 1;
        pedir('POST', `${location}/ubicaciones`, chofer.token, posicion)
          .then((r) => {
            if (r.estado === 204) {
              estadisticas.pings_ok += 1;
              okPorChofer[i] += 1;
            } else estadisticas.pings_fallidos += 1;
          })
          .catch(() => {
            estadisticas.pings_fallidos += 1;
          })
          .finally(() => {
            estadisticas.pings_en_vuelo -= 1;
          });
      }
    })();

    // Si el evento que lo libera no llega (el stream se cortó justo), se confirma por GET.
    void (async () => {
      while (vivo) {
        await esperar(5_000);
        if (ocupadoCon && ocupadoCon !== 'aceptando' && Date.now() - ocupadoDesde > 60_000) {
          const r = await pedir('GET', `${dispatch}/chofer/estado`, chofer.token).catch(() => null);
          if (r?.estado === 200 && !r.json?.viaje) {
            ocupadoCon = null;
            estadisticas.liberados_por_consulta += 1;
          }
        }
      }
    })();

    const aceptar = async (oferta) => {
      ocupadoCon = 'aceptando';
      const r = await conClave('POST', `${dispatch}/ofertas/${oferta.ofertaId}/aceptar`, chofer.token, {}, () => (estadisticas.reintentos += 1));
      if (r.estado === 200) {
        estadisticas.aceptadas_200 += 1;
        if (chofer.tipo !== 'apto') estadisticas.aceptadas_por_no_aptos += 1;
        enEspera = [];
        if (terminados.has(oferta.solicitudId)) {
          // El pasajero canceló antes de que llegara este 200: queda libre.
          ocupadoCon = null;
          estadisticas.liberados_por_evento += 1;
        } else {
          ocupadoCon = oferta.solicitudId;
          ocupadoDesde = Date.now();
        }
        return;
      }
      ocupadoCon = null;
      const codigo = r.json?.error?.code ?? `HTTP_${r.estado}`;
      const otra = siguienteVigente();
      if (otra) {
        estadisticas.ofertas_en_espera_probadas += 1;
        void aceptar(otra);
      }
      // Esperados con varios choferes por viaje: otro ganó, el pasajero ya canceló o la oferta venció.
      if (r.estado === 409 && ['SOLICITUD_NO_DISPONIBLE', 'OFERTA_VENCIDA', 'CHOFER_CON_VIAJE_ACTIVO'].includes(codigo)) {
        sumar(estadisticas.rechazos_409_esperados, codigo);
      } else {
        sumar(estadisticas.aceptar_errores, `${r.estado}_${codigo}`);
      }
    };

    void escucharSse(
      dispatch,
      chofer.token,
      () => vivo,
      (tipo, datos) => {
        if (tipo === 'OfferCreated' && datos.choferId === chofer.id) {
          estadisticas.ofertas_recibidas += 1;
          if (chofer.tipo !== 'apto') estadisticas.ofertas_a_no_aptos += 1;
          if (ocupadoCon === 'aceptando') {
            enEspera.push(datos);
            return;
          }
          if (ocupadoCon) {
            estadisticas.ofertas_ignoradas_ocupado += 1;
            return;
          }
          void aceptar(datos);
        } else if ((tipo === 'RideCancelled' || tipo === 'RideCompleted') && datos.choferId === chofer.id) {
          terminados.add(datos.solicitudId);
          if (terminados.size > 200) terminados.delete(terminados.values().next().value);
          if (ocupadoCon === datos.solicitudId) {
            ocupadoCon = null;
            estadisticas.liberados_por_evento += 1;
          }
        }
      },
      {
        alConectar: () => {
          conectados += 1;
          if (conectados > choferes.length) estadisticas.sse_reconexiones += 1;
        },
        alError: (err) => log(`SSE del chofer ${chofer.id.slice(-4)}: ${err}`),
      },
    );
  };

  choferes.forEach(uno);
  return {
    estadisticas,
    /**
     * Foto de los pings para medir una ventana: `ventanaPings(antes, despues, segundos)` da los
     * enviados y aceptados por location (204) en ella, por segundo, y cuántos choferes tuvieron al
     * menos un ping aceptado.
     */
    fotoPings: () => ({
      enviados: estadisticas.pings_enviados,
      ok: estadisticas.pings_ok,
      fallidos: estadisticas.pings_fallidos,
      porChofer: [...okPorChofer],
    }),
    conectados: () => Math.min(conectados, choferes.length),
    parar: () => {
      vivo = false;
    },
  };
}
