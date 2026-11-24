import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Punto } from '../viaje/viaje';

/** El Obelisco: el centro de la zona CABA de la demo (`npm run demo:flotas`). */
export const CENTRO_DEMO: Punto = { lat: -34.6037, lng: -58.3816 };

export interface Marcas {
  origen?: Punto | null;
  destino?: Punto | null;
  /** La otra parte del viaje en vivo (el chofer, para el pasajero). */
  movil?: Punto | null;
  /** Si la posición del móvil ya no es reciente: se dibuja apagada. */
  movilVieja?: boolean;
}

/**
 * Un mapa de OpenStreetMap con Leaflet. La librería va en el bundle; lo único que viene de afuera son
 * las teselas (`img-src https://tile.openstreetmap.org` en la CSP de nginx). Nada en línea: Leaflet
 * posiciona con la CSSOM (`element.style` desde JS), que la CSP permite, y los puntos son círculos SVG.
 *
 * - `alTocar`: el pasajero marca un punto con un clic.
 * - Se encuadra solo cuando cambian el origen o el destino, no con cada posición del móvil: así no le
 *   saca el control a quien está mirando el mapa.
 */
export function Mapa({ marcas, alTocar, etiqueta }: { marcas: Marcas; alTocar?: (p: Punto) => void; etiqueta: string }) {
  const contenedor = useRef<HTMLDivElement>(null);
  const mapa = useRef<L.Map | null>(null);
  const capas = useRef<L.LayerGroup | null>(null);
  /** Vuelve a encuadrar el recorrido (lo llama el observador de tamaño). */
  const encuadre = useRef<(() => void) | null>(null);
  const alTocarRef = useRef(alTocar);
  alTocarRef.current = alTocar;

  useEffect(() => {
    if (!contenedor.current) return;
    const m = L.map(contenedor.current, { attributionControl: false, zoomControl: true }).setView([CENTRO_DEMO.lat, CENTRO_DEMO.lng], 13);
    // La página va con `Referrer-Policy: no-referrer`, pero la política de uso de OpenStreetMap pide
    // el Referer en las teselas: solo a ellas se les manda el origen (nunca la ruta).
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(m);
    // Sin el prefijo de Leaflet (lleva un SVG en línea): solo la atribución que pide OpenStreetMap.
    L.control
      .attribution({ prefix: false })
      .addAttribution('© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>')
      .addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => alTocarRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    capas.current = L.layerGroup().addTo(m);
    mapa.current = m;
    // El contenedor puede cambiar de tamaño con la grilla (columnas que aparecen o se van).
    const observador = new ResizeObserver(() => {
      m.invalidateSize({ animate: false });
      encuadre.current?.();
    });
    observador.observe(contenedor.current);
    return () => {
      observador.disconnect();
      m.remove();
      mapa.current = null;
      capas.current = null;
    };
  }, []);

  const { origen, destino, movil, movilVieja } = marcas;
  useEffect(() => {
    const grupo = capas.current;
    if (!grupo) return;
    grupo.clearLayers();
    if (origen && destino) {
      L.polyline(
        [
          [origen.lat, origen.lng],
          [destino.lat, destino.lng],
        ],
        { className: 'mapa-recorrido', interactive: false },
      ).addTo(grupo);
    }
    if (origen) L.circleMarker([origen.lat, origen.lng], { radius: 8, className: 'mapa-origen' }).bindTooltip('Origen').addTo(grupo);
    if (destino) L.circleMarker([destino.lat, destino.lng], { radius: 8, className: 'mapa-destino' }).bindTooltip('Destino').addTo(grupo);
    if (movil) {
      const clase = movilVieja ? 'mapa-movil vieja' : 'mapa-movil';
      L.circleMarker([movil.lat, movil.lng], { radius: 16, className: `${clase} halo`, interactive: false }).addTo(grupo);
      L.circleMarker([movil.lat, movil.lng], { radius: 8, className: clase }).bindTooltip('Chofer').addTo(grupo);
    }
  }, [origen, destino, movil, movilVieja]);

  // Encuadre: con origen y destino, los dos; con uno solo, ese. Sin animación (dos cambios seguidos
  // dejaban el segundo a medio camino), y se repite si el mapa cambia de tamaño.
  const oLat = origen?.lat;
  const oLng = origen?.lng;
  const dLat = destino?.lat;
  const dLng = destino?.lng;
  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    const puntos: L.LatLngTuple[] = [];
    if (oLat !== undefined && oLng !== undefined) puntos.push([oLat, oLng]);
    if (dLat !== undefined && dLng !== undefined) puntos.push([dLat, dLng]);
    const encuadrar = () => {
      m.invalidateSize({ animate: false });
      if (puntos.length === 2) m.fitBounds(L.latLngBounds(puntos), { padding: [56, 56], maxZoom: 15, animate: false });
      else if (puntos.length === 1) m.setView(puntos[0]!, Math.max(m.getZoom(), 14), { animate: false });
    };
    encuadrar();
    encuadre.current = puntos.length > 0 ? encuadrar : null;
  }, [oLat, oLng, dLat, dLng]);

  return <div ref={contenedor} className="mapa" role="application" aria-label={etiqueta} />;
}
