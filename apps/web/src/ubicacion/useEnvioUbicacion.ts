import { useEffect, useRef, useState } from 'react';
import { pedir } from '../api/cliente';
import type { ErrorApi } from '../api/errores';
import { posicionParaEnviar, REENVIO_MS, type Fijacion, type Fuente } from './posicion';

/**
 * Las coordenadas manuales (demo) se recuerdan en la pestaña, así una recarga a mitad de viaje sigue
 * enviando. Es solo una comodidad: si el almacenamiento no está, se vuelve al GPS.
 */
const CLAVE_MANUAL = 'viajes:ubicacion-manual:';

function leerManual(ruta: string): { lat: number; lng: number } | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(CLAVE_MANUAL + ruta) ?? 'null') as { lat?: unknown; lng?: unknown } | null;
    return v && typeof v.lat === 'number' && typeof v.lng === 'number' ? { lat: v.lat, lng: v.lng } : null;
  } catch {
    return null;
  }
}

function guardarManual(ruta: string, c: { lat: number; lng: number } | null): void {
  try {
    if (c) sessionStorage.setItem(CLAVE_MANUAL + ruta, JSON.stringify({ lat: c.lat, lng: c.lng }));
    else sessionStorage.removeItem(CLAVE_MANUAL + ruta);
  } catch {
    // Sin almacenamiento: no se recuerda, nada más.
  }
}

/** Entre dos envíos, como mínimo: un GPS en movimiento da una posición por segundo. */
const MINIMO_ENTRE_ENVIOS_MS = 2_000;

export interface EnvioUbicacion {
  activo: boolean;
  modo: Fuente;
  cambiarModo(modo: Fuente): void;
  /** La posición que se usa ahora (la del GPS o la manual, según el modo). */
  fijacion: Fijacion | null;
  /** Modo manual (demo): fija estas coordenadas. */
  fijarManual(coordenadas: { lat: number; lng: number }): void;
  errorGps: string | null;
  ultimoEnvio: number | null;
  errorEnvio: ErrorApi | null;
}

/**
 * Envía la posición del usuario a location mientras `activo` (la del chofer a `/ubicacion/ubicaciones`,
 * la del pasajero a `/ubicacion/ubicaciones/pasajero`):
 * - **GPS:** `watchPosition` y, además, un reenvío cada 5 s de la última posición, para seguir vigente
 *   aunque no se mueva. Solo si es reciente (15 s o menos, `posicion.ts`): una posición vieja deja de
 *   enviarse y la pantalla lo muestra.
 * - **Manual (demo):** coordenadas cargadas a mano, para probar sin GPS o si se rechazó el permiso.
 * - No reintenta: el próximo envío reemplaza al que falló.
 */
export function useEnvioUbicacion(ruta: string, activo: boolean): EnvioUbicacion {
  const hayGps = typeof navigator !== 'undefined' && 'geolocation' in navigator;
  const [guardado] = useState(() => leerManual(ruta));
  const [modo, setModo] = useState<Fuente>(guardado ? 'manual' : hayGps ? 'gps' : 'manual');
  const [gps, setGps] = useState<Fijacion | null>(null);
  const [manual, setManual] = useState<Fijacion | null>(guardado && { ...guardado, tomadaEn: Date.now(), fuente: 'manual' });
  const [errorGps, setErrorGps] = useState<string | null>(hayGps ? null : 'Este navegador no da la ubicación: usá el modo manual.');
  const [envio, setEnvio] = useState<{ ultimo: number | null; error: ErrorApi | null }>({ ultimo: null, error: null });
  const fijacion = modo === 'gps' ? gps : manual;

  const enVuelo = useRef(false);
  const ultimo = useRef(0);

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

  // Envía enseguida con cada posición nueva y después cada 5 s. Cada vez decide con la hora del
  // momento: si la posición envejeció, no la manda.
  useEffect(() => {
    if (!activo) return;
    const enviar = async () => {
      if (enVuelo.current || Date.now() - ultimo.current < MINIMO_ENTRE_ENVIOS_MS) return;
      const cuerpo = posicionParaEnviar(fijacion, Date.now());
      if (!cuerpo) return;
      enVuelo.current = true;
      try {
        await pedir('POST', ruta, { cuerpo });
        ultimo.current = Date.now();
        setEnvio({ ultimo: ultimo.current, error: null });
      } catch (err) {
        setEnvio((e) => ({ ...e, error: err as ErrorApi }));
      } finally {
        enVuelo.current = false;
      }
    };
    void enviar();
    const t = setInterval(() => void enviar(), REENVIO_MS);
    return () => clearInterval(t);
  }, [activo, ruta, fijacion]);

  return {
    activo,
    modo,
    cambiarModo: (m) => {
      setModo(m);
      if (m === 'gps') guardarManual(ruta, null);
      else if (manual) guardarManual(ruta, manual);
    },
    fijacion,
    fijarManual: (c) => {
      setManual({ ...c, tomadaEn: Date.now(), fuente: 'manual' });
      guardarManual(ruta, c);
    },
    errorGps: modo === 'gps' ? errorGps : null,
    ultimoEnvio: envio.ultimo,
    errorEnvio: envio.error,
  };
}
