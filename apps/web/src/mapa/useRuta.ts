import type { RutaRespuesta } from '@viajes/contracts';
import { useEffect, useRef, useState } from 'react';
import { pedir } from '../api/cliente';
import { distanciaMetros, type Punto } from '../viaje/viaje';

export type Ruta = RutaRespuesta;

/** Cuánto se tiene que mover la punta móvil (el auto) para pedir la ruta de nuevo. */
const UMBRAL_METROS = 120;

const consulta = (a: Punto, b: Punto) =>
  new URLSearchParams({
    origenLat: a.lat.toFixed(6),
    origenLng: a.lng.toFixed(6),
    destinoLat: b.lat.toFixed(6),
    destinoLng: b.lng.toFixed(6),
  }).toString();

/**
 * La ruta por las calles de `desde` a `hasta` (`GET /viajes/rutas`), para dibujarla en el mapa.
 *
 * Si `desde` es el auto, cambia cada segundo: la ruta se vuelve a pedir solo cuando se movió más de
 * 120 m desde la última, o cuando cambia `hasta`. Así se cuida el límite por usuario y el servidor de
 * ruteo. Mientras no hay respuesta (o si falla), devuelve la última que tenga para ese destino, o null:
 * el mapa dibuja entonces la línea recta.
 */
export function useRuta(desde: Punto | null, hasta: Punto | null): Ruta | null {
  const [ruta, setRuta] = useState<{ clave: string; ruta: Ruta } | null>(null);
  const pedida = useRef<{ desde: Punto; claveHasta: string } | null>(null);
  /** El número del último pedido: solo su respuesta cuenta (una más vieja que llega tarde, no). */
  const ultimo = useRef(0);

  const claveHasta = hasta ? `${hasta.lat.toFixed(5)},${hasta.lng.toFixed(5)}` : '';
  const dLat = desde?.lat;
  const dLng = desde?.lng;

  useEffect(() => {
    if (dLat === undefined || dLng === undefined || !hasta) {
      pedida.current = null;
      return;
    }
    const origen = { lat: dLat, lng: dLng };
    const anterior = pedida.current;
    if (anterior && anterior.claveHasta === claveHasta && distanciaMetros(anterior.desde, origen) < UMBRAL_METROS) return;
    pedida.current = { desde: origen, claveHasta };
    // Sin cancelar al volver a correr: el auto se mueve cada segundo y el efecto corre otra vez antes
    // de que llegue la respuesta. Lo que decide es si sigue siendo el último pedido.
    const n = ++ultimo.current;
    pedir<Ruta>('GET', `/viajes/rutas?${consulta(origen, hasta)}`)
      .then((r) => {
        if (n === ultimo.current) setRuta({ clave: claveHasta, ruta: r });
      })
      .catch(() => {
        // Sin ruta (límite, red): se queda la anterior o la línea recta. No se insiste con cada
        // posición: se vuelve a pedir cuando el auto se mueva otros 120 m o cambie el destino.
      });
    // `hasta` entra por su clave: un objeto nuevo con las mismas coordenadas no vuelve a pedir.
  }, [dLat, dLng, claveHasta]);

  if (!desde || !hasta || !ruta || ruta.clave !== claveHasta) return null;
  return ruta.ruta;
}
