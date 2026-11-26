import { useEffect, useRef, useState } from 'react';
import { pedir } from '../api/cliente';
import type { ErrorApi } from '../api/errores';
import type { Punto } from '../viaje/viaje';
import { posicionParaEnviar, REENVIO_MS, REENVIO_SIMULADA_MS, type Fijacion, type Fuente } from './posicion';
import { PARTIDA_SIMULADA } from './simulacion';

/**
 * Lo que se recuerda en la pestaña, así una recarga a mitad de viaje sigue enviando desde el mismo
 * lugar: las coordenadas manuales, la posición del auto simulado y (si hay modo simulado) el modo
 * elegido. Es solo una comodidad: si el almacenamiento no está, se vuelve al modo por defecto. Se borra
 * al cerrar sesión (`cerrarSesion`, prefijo `viajes:ubicacion-`).
 */
const CLAVE_MANUAL = 'viajes:ubicacion-manual:';
const CLAVE_SIMULADA = 'viajes:ubicacion-simulada:';
const CLAVE_MODO = 'viajes:ubicacion-modo:';

function leerPunto(clave: string): Punto | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(clave) ?? 'null') as { lat?: unknown; lng?: unknown } | null;
    return v && typeof v.lat === 'number' && typeof v.lng === 'number' ? { lat: v.lat, lng: v.lng } : null;
  } catch {
    return null;
  }
}

function guardar(clave: string, valor: unknown): void {
  try {
    if (valor !== null) sessionStorage.setItem(clave, JSON.stringify(valor));
    else sessionStorage.removeItem(clave);
  } catch {
    // Sin almacenamiento: no se recuerda, nada más.
  }
}

function leerModo(ruta: string): Fuente | null {
  try {
    const m = JSON.parse(sessionStorage.getItem(CLAVE_MODO + ruta) ?? 'null') as unknown;
    return m === 'gps' || m === 'manual' || m === 'simulada' ? m : null;
  } catch {
    return null;
  }
}

/**
 * Entre dos envíos, como mínimo: un GPS en movimiento da una posición por segundo. En la simulada, el
 * envío lo marca un solo reloj de 1 s; el mínimo solo evita un envío doble al reiniciarlo.
 */
const MINIMO_ENTRE_ENVIOS_MS = 2_000;
const MINIMO_SIMULADA_MS = 500;

export interface EnvioUbicacion {
  activo: boolean;
  modo: Fuente;
  cambiarModo(modo: Fuente): void;
  /** Si se ofrece el modo «Simulada (demo)» (solo el chofer). */
  permiteSimulada: boolean;
  /** La posición que se usa ahora (la del GPS, la manual o la simulada, según el modo). */
  fijacion: Fijacion | null;
  /** Modo manual (demo): fija estas coordenadas. */
  fijarManual(coordenadas: Punto): void;
  /** Modo simulado: mueve el auto a este punto (lo llama la conducción simulada, cada 1 s). */
  fijarSimulada(coordenadas: Punto): void;
  errorGps: string | null;
  ultimoEnvio: number | null;
  /** Las coordenadas del último envío que location aceptó. */
  enviada: Punto | null;
  errorEnvio: ErrorApi | null;
}

function modoInicial(ruta: string, simulada: boolean, hayGps: boolean, hayManual: boolean): Fuente {
  if (simulada) {
    const m = leerModo(ruta);
    if (m) return m === 'gps' && !hayGps ? 'manual' : m;
    return hayManual ? 'manual' : 'simulada';
  }
  return hayManual ? 'manual' : hayGps ? 'gps' : 'manual';
}

/**
 * Envía la posición del usuario a location mientras `activo` (la del chofer a `/ubicacion/ubicaciones`,
 * la del pasajero a `/ubicacion/ubicaciones/pasajero`):
 * - **GPS:** `watchPosition` y, además, un reenvío cada 5 s de la última posición, para seguir vigente
 *   aunque no se mueva. Solo si es reciente (15 s o menos, `posicion.ts`): una posición vieja deja de
 *   enviarse y la pantalla lo muestra.
 * - **Manual (demo):** coordenadas cargadas a mano, para probar sin GPS o si se rechazó el permiso.
 *   También cada 5 s.
 * - **Simulada (demo, `{ simulada: true }`, solo el chofer y su modo por defecto):** el auto que maneja
 *   solo (`useConduccionSimulada`). Se envía cada 1 s, con un solo reloj y sin superponer pedidos: 60
 *   por minuto, dentro de los 120 que admite location. Quieto, sigue enviando: así sigue siendo candidato.
 * - No reintenta: el próximo envío reemplaza al que falló.
 */
export function useEnvioUbicacion(ruta: string, activo: boolean, { simulada = false }: { simulada?: boolean } = {}): EnvioUbicacion {
  const hayGps = typeof navigator !== 'undefined' && 'geolocation' in navigator;
  const [guardado] = useState(() => leerPunto(CLAVE_MANUAL + ruta));
  const [modo, setModo] = useState<Fuente>(() => modoInicial(ruta, simulada, hayGps, guardado !== null));
  const [gps, setGps] = useState<Fijacion | null>(null);
  const [manual, setManual] = useState<Fijacion | null>(guardado && { ...guardado, tomadaEn: Date.now(), fuente: 'manual' });
  const [simulacion, setSimulacion] = useState<Fijacion | null>(() =>
    simulada ? { ...(leerPunto(CLAVE_SIMULADA + ruta) ?? PARTIDA_SIMULADA), tomadaEn: Date.now(), fuente: 'simulada' } : null,
  );
  const [errorGps, setErrorGps] = useState<string | null>(hayGps ? null : 'Este navegador no da la ubicación: usá el modo manual.');
  const [envio, setEnvio] = useState<{ ultimo: number | null; enviada: Punto | null; error: ErrorApi | null }>({
    ultimo: null,
    enviada: null,
    error: null,
  });
  const fijacion = modo === 'gps' ? gps : modo === 'manual' ? manual : simulacion;

  const enVuelo = useRef(false);
  const ultimo = useRef(0);
  // El envío lee la posición del momento: el reloj no se rehace con cada posición nueva.
  const actual = useRef({ fijacion, modo });
  actual.current = { fijacion, modo };

  useEffect(() => {
    if (!activo || modo !== 'gps' || !hayGps) return;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setGps({ lat: p.coords.latitude, lng: p.coords.longitude, tomadaEn: p.timestamp, fuente: 'gps' });
        setErrorGps(null);
      },
      (e) =>
        setErrorGps(
          e.code === e.PERMISSION_DENIED
            ? 'No diste permiso para usar la ubicación: usá el modo manual.'
            : 'El GPS no está dando la posición.',
        ),
      { enableHighAccuracy: true, maximumAge: REENVIO_MS, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [activo, modo, hayGps]);

  // Cada envío decide con la hora del momento: si la posición envejeció, no la manda.
  const enviar = useRef(async () => {});
  enviar.current = async () => {
    const minimo = actual.current.modo === 'simulada' ? MINIMO_SIMULADA_MS : MINIMO_ENTRE_ENVIOS_MS;
    if (enVuelo.current || Date.now() - ultimo.current < minimo) return;
    const cuerpo = posicionParaEnviar(actual.current.fijacion, Date.now());
    if (!cuerpo) return;
    enVuelo.current = true;
    try {
      await pedir('POST', ruta, { cuerpo });
      ultimo.current = Date.now();
      setEnvio({ ultimo: ultimo.current, enviada: cuerpo, error: null });
    } catch (err) {
      setEnvio((e) => ({ ...e, error: err as ErrorApi }));
    } finally {
      enVuelo.current = false;
    }
  };

  // El reloj: enseguida y después cada 5 s (GPS y manual) o cada 1 s (simulada).
  useEffect(() => {
    if (!activo) return;
    void enviar.current();
    const t = setInterval(() => void enviar.current(), modo === 'simulada' ? REENVIO_SIMULADA_MS : REENVIO_MS);
    return () => clearInterval(t);
  }, [activo, ruta, modo]);

  // GPS y manual: cada posición nueva sale enseguida (con el mínimo de 2 s). La simulada cambia cada
  // 1 s y la manda el reloj: así hay un solo flujo de envío.
  useEffect(() => {
    if (activo && fijacion && fijacion.fuente !== 'simulada') void enviar.current();
  }, [activo, fijacion]);

  return {
    activo,
    modo,
    permiteSimulada: simulada,
    cambiarModo: (m) => {
      if (m === 'simulada' && !simulada) return;
      setModo(m);
      if (simulada) guardar(CLAVE_MODO + ruta, m);
      if (m === 'gps') guardar(CLAVE_MANUAL + ruta, null);
      else if (m === 'manual' && manual) guardar(CLAVE_MANUAL + ruta, { lat: manual.lat, lng: manual.lng });
    },
    fijacion,
    fijarManual: (c) => {
      setManual({ ...c, tomadaEn: Date.now(), fuente: 'manual' });
      guardar(CLAVE_MANUAL + ruta, { lat: c.lat, lng: c.lng });
    },
    fijarSimulada: (c) => {
      if (!simulada) return;
      setSimulacion({ ...c, tomadaEn: Date.now(), fuente: 'simulada' });
      guardar(CLAVE_SIMULADA + ruta, { lat: c.lat, lng: c.lng });
    },
    errorGps: modo === 'gps' ? errorGps : null,
    ultimoEnvio: envio.ultimo,
    enviada: envio.enviada,
    errorEnvio: envio.error,
  };
}
