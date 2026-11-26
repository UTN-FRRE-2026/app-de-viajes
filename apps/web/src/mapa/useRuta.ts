import type { RutaRespuesta } from '@viajes/contracts';
import { useEffect, useRef, useState } from 'react';
import { pedir } from '../api/cliente';
import { distanciaMetros, type Punto } from '../viaje/viaje';

export type Ruta = RutaRespuesta;

/** Cuánto se tiene que mover el auto para pedir de nuevo la ruta que sale de él (`useRuta(..., { auto: true })`). */
export const UMBRAL_AUTO_METROS = 120;

const consulta = (a: Punto, b: Punto) =>
  new URLSearchParams({
    origenLat: a.lat.toFixed(6),
    origenLng: a.lng.toFixed(6),
    destinoLat: b.lat.toFixed(6),
    destinoLng: b.lng.toFixed(6),
  }).toString();

/** `GET /viajes/rutas`: la ruta por las calles (dispatch → OSRM), o la recta si el ruteo no responde. */
export const pedirRuta = (desde: Punto, hasta: Punto) => pedir<Ruta>('GET', `/viajes/rutas?${consulta(desde, hasta)}`);

const clavePunto = (p: Punto) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

/**
 * Qué identifica a una ruta. Con el auto, solo el destino: la de hace unos metros sigue sirviendo
 * mientras llega la nueva. Con puntos elegidos, los dos extremos: cambiar el origen descarta la vieja.
 */
export const claveRuta = (desde: Punto, hasta: Punto, auto: boolean) =>
  auto ? clavePunto(hasta) : `${clavePunto(desde)}>${clavePunto(hasta)}`;

/**
 * Si hay que pedir la ruta otra vez. Con puntos elegidos, siempre que cambie la clave (cualquier
 * extremo). Con el auto, también cuando se movió 120 m o más desde el último pedido.
 */
export function hayQuePedir(anterior: { desde: Punto; clave: string } | null, desde: Punto, clave: string, auto: boolean): boolean {
  if (!anterior || anterior.clave !== clave) return true;
  return auto && distanciaMetros(anterior.desde, desde) >= UMBRAL_AUTO_METROS;
}

/**
 * La ruta por las calles de `desde` a `hasta` (`GET /viajes/rutas`), para dibujarla en el mapa.
 *
 * - **Puntos elegidos** (por defecto: el origen y el destino del pasajero): cualquier cambio de
 *   cualquiera de los dos pide la ruta de nuevo, y la del punto anterior deja de mostrarse. Un origen
 *   movido unos metros (la otra esquina, una calle de una mano) puede cambiar la ruta entera.
 * - **`auto: true`**, cuando `desde` es el auto: cambia cada segundo, así que la ruta se vuelve a pedir
 *   solo cuando se movió más de 120 m desde la última, o cuando cambia `hasta`. Mientras tanto sigue la
 *   última que hay para ese destino. Así se cuida el límite por usuario y el servidor de ruteo.
 *
 * Mientras no hay respuesta (o si falla), devuelve null y el mapa dibuja la línea recta.
 */
export function useRuta(desde: Punto | null, hasta: Punto | null, { auto = false }: { auto?: boolean } = {}): Ruta | null {
  const [ruta, setRuta] = useState<{ clave: string; ruta: Ruta } | null>(null);
  const pedida = useRef<{ desde: Punto; clave: string } | null>(null);
  /** El número del último pedido: solo su respuesta cuenta (una más vieja que llega tarde, no). */
  const ultimo = useRef(0);

  const clave = desde && hasta ? claveRuta(desde, hasta, auto) : '';
  const dLat = desde?.lat;
  const dLng = desde?.lng;

  useEffect(() => {
    if (dLat === undefined || dLng === undefined || !hasta) {
      pedida.current = null;
      return;
    }
    const origen = { lat: dLat, lng: dLng };
    if (!hayQuePedir(pedida.current, origen, clave, auto)) return;
    pedida.current = { desde: origen, clave };
    // Sin cancelar al volver a correr: el auto se mueve cada segundo y el efecto corre otra vez antes
    // de que llegue la respuesta. Lo que decide es si sigue siendo el último pedido.
    const n = ++ultimo.current;
    pedirRuta(origen, hasta)
      .then((r) => {
        if (n === ultimo.current) setRuta({ clave, ruta: r });
      })
      .catch(() => {
        // Sin ruta (límite, red): queda la línea recta (o, con el auto, la anterior). No se insiste con
        // cada posición: se vuelve a pedir cuando cambie un extremo o el auto se mueva otros 120 m.
      });
    // `hasta` entra por su clave: un objeto nuevo con las mismas coordenadas no vuelve a pedir.
  }, [dLat, dLng, clave, auto]);

  if (!desde || !hasta || !ruta || ruta.clave !== clave) return null;
  return ruta.ruta;
}
