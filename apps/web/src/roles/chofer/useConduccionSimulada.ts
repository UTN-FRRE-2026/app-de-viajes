import { useEffect, useRef, useState } from 'react';
import { pedirRuta, type Ruta } from '../../mapa/useRuta';
import {
  armarRecorrido,
  avanzar,
  llego,
  PASO_SIMULADO_MS,
  polilineaDelTramo,
  puntoEn,
  restante,
  VELOCIDAD_SIMULADA_KMH,
  yaEsta,
  type Recorrido,
} from '../../ubicacion/simulacion';
import type { Punto, Solicitud } from '../../viaje/viaje';

/** Lo que muestra la pantalla del tramo simulado. */
export interface Conduccion {
  /** La ruta fija del tramo, la misma que se maneja: para dibujarla. Null mientras se pide. */
  ruta: Ruta | null;
  /** Lo que falta por esa ruta, en metros y en segundos (los de la ruta, en proporción). */
  restanteMetros: number | null;
  restanteSegundos: number | null;
  /** Llegó al final del tramo y está quieto ahí. */
  llego: boolean;
}

const SIN_TRAMO: Conduccion = { ruta: null, restanteMetros: null, restanteSegundos: null, llego: false };

/** Un paso de reloj atrasado (pestaña en segundo plano) avanza como mucho esto: no se teletransporta. */
const PASO_MAXIMO_S = 5;

interface Tramo {
  clave: string;
  recorrido: Recorrido | null;
  ruta: Ruta | null;
  andados: number;
  llego: boolean;
}

/** La ruta del tramo como la devuelve la API, pero con la polilínea que se maneja (auto → … → punto exacto). */
function rutaDelTramo(recorrido: Recorrido, base: Ruta | null): Ruta {
  return {
    puntos: recorrido.puntos.map((p) => [p.lat, p.lng] as [number, number]),
    distanciaMetros: Math.round(recorrido.total),
    // Sin ruta (falló el pedido), el tiempo es el de la velocidad simulada.
    duracionSegundos: base?.duracionSegundos ?? Math.round(recorrido.total / (VELOCIDAD_SIMULADA_KMH / 3.6)),
    fuente: base?.fuente ?? 'recta',
  };
}

/**
 * La conducción simulada del chofer («Simulada (demo)»): con el viaje en camino, el auto maneja solo
 * hasta el origen; en curso, hasta el destino. A `VELOCIDAD_SIMULADA_KMH`, un paso cada 1 s, y cada
 * posición nueva va a `mover` (el envío de ubicación la manda a location por el camino de siempre).
 *
 * - **Una ruta fija por tramo**, pedida una vez desde donde está el auto al empezar el tramo
 *   (`GET /viajes/rutas`, dispatch → OSRM): la misma se maneja y se dibuja. La ruta «del auto» del
 *   mapa se vuelve a pedir cada 120 m; seguirla haría que el camino cambie a cada rato.
 * - Si el ruteo no responde, dispatch da la recta (`fuente: 'recta'`); si falla el pedido, también se
 *   va en línea recta.
 * - **Al llegar** se detiene justo en el punto y lo dice (`llego`). Si al empezar el tramo ya está a
 *   20 m o menos (una recarga en el origen), llegó sin manejar.
 * - Al apagarse (`activa`), cambiar de viaje o de estado, o cancelarse, frena, y una respuesta de ruta
 *   que llegue tarde se ignora.
 */
export function useConduccionSimulada({
  activa,
  viaje,
  posicion,
  mover,
}: {
  activa: boolean;
  viaje: Solicitud | null;
  posicion: Punto | null;
  mover: (p: Punto) => void;
}): Conduccion {
  const meta = !activa || !viaje ? null : viaje.estado === 'EN_CAMINO' ? viaje.origen : viaje.estado === 'EN_CURSO' ? viaje.destino : null;
  const clave = meta && viaje ? `${viaje.id}:${viaje.estado}` : null;

  const [tramo, setTramo] = useState<Tramo | null>(null);
  // Se leen al empezar el tramo y en cada paso, sin rehacer los efectos con cada posición.
  const actual = useRef({ posicion, mover, meta });
  actual.current = { posicion, mover, meta };

  // Empieza un tramo: fija desde dónde y pide la ruta una sola vez.
  useEffect(() => {
    const destino = actual.current.meta;
    const desde = actual.current.posicion;
    if (!clave || !destino || !desde) {
      // Sin tramo (otro modo, sin viaje, asignado): se olvida el anterior, así volver no lo retoma.
      setTramo(null);
      return;
    }
    if (yaEsta(desde, destino)) {
      const recorrido = armarRecorrido([desde, destino]);
      setTramo({ clave, recorrido, ruta: rutaDelTramo(recorrido, null), andados: recorrido.total, llego: true });
      actual.current.mover(destino);
      return;
    }
    setTramo({ clave, recorrido: null, ruta: null, andados: 0, llego: false });
    let vigente = true;
    const usar = (base: Ruta | null) => {
      if (!vigente) return;
      const recorrido = armarRecorrido(polilineaDelTramo(desde, destino, base?.puntos ?? null));
      setTramo({ clave, recorrido, ruta: rutaDelTramo(recorrido, base), andados: 0, llego: false });
    };
    pedirRuta(desde, destino).then(usar, () => usar(null));
    return () => {
      vigente = false;
    };
  }, [clave]);

  // Maneja: un paso por segundo, con el tiempo que pasó de verdad (acotado), hasta llegar.
  const vigente = tramo !== null && tramo.clave === clave;
  const recorrido = vigente ? tramo.recorrido : null;
  const yaLlego = vigente && tramo.llego;
  useEffect(() => {
    if (!recorrido || yaLlego || !clave) return;
    let andados = 0;
    let antes = Date.now();
    const t = setInterval(() => {
      const ahora = Date.now();
      const segundos = Math.min(PASO_MAXIMO_S, (ahora - antes) / 1000);
      antes = ahora;
      andados = avanzar(recorrido, andados, VELOCIDAD_SIMULADA_KMH, segundos);
      const fin = llego(recorrido, andados);
      actual.current.mover(fin ? recorrido.puntos[recorrido.puntos.length - 1]! : puntoEn(recorrido, andados));
      setTramo((x) => (x && x.clave === clave ? { ...x, andados: fin ? recorrido.total : andados, llego: fin } : x));
    }, PASO_SIMULADO_MS);
    return () => clearInterval(t);
  }, [clave, recorrido, yaLlego]);

  if (!vigente) return SIN_TRAMO;
  if (!tramo.recorrido || !tramo.ruta) return { ...SIN_TRAMO, llego: tramo.llego };
  const metros = restante(tramo.recorrido, tramo.andados);
  const proporcion = tramo.recorrido.total > 0 ? metros / tramo.recorrido.total : 0;
  return {
    ruta: tramo.ruta,
    restanteMetros: metros,
    restanteSegundos: Math.round(tramo.ruta.duracionSegundos * proporcion),
    llego: tramo.llego,
  };
}
