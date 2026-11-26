import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { SVG_AUTO } from '../componentes/Iconos';
import { distanciaMetros, type Punto } from '../viaje/viaje';

/** La Plaza 25 de Mayo de Resistencia: el centro de la zona «Resistencia» de la demo (`npm run demo:flotas`). */
export const CENTRO_DEMO: Punto = { lat: -27.4511, lng: -58.9865 };

export interface Marcas {
  origen?: Punto | null;
  destino?: Punto | null;
  /** El auto: el chofer (para el pasajero) o uno mismo (para el chofer). */
  movil?: Punto | null;
  /** Si la posición del auto ya no es reciente: se dibuja apagado. */
  movilVieja?: boolean;
  /** La otra persona del viaje (el pasajero, para el chofer). */
  persona?: Punto | null;
  /** La ruta principal por las calles, pares [lat, lng]. Sin ella, la línea recta de origen a destino. */
  ruta?: [number, number][] | null;
  /** El tramo del auto hasta el punto que importa ahora (el origen, mientras lo viene a buscar). */
  aproximacion?: [number, number][] | null;
  /** Lo que falta por las calles: se escribe en un mojón sobre la ruta que se ve (el tramo, si lo hay). */
  mojonMetros?: number | null;
}

/** Por debajo de esto, el mojón quedaría encima del auto o del pin: se ve la distancia en la hoja. */
const MOJON_MINIMO_METROS = 800;

/** El punto de la línea que está a la fracción `k` de su largo (0,5: la mitad). */
function puntoDelTramo(puntos: [number, number][], k: number): [number, number] {
  const tramos = puntos.slice(1).map((p, i) => distanciaMetros({ lat: puntos[i]![0], lng: puntos[i]![1] }, { lat: p[0], lng: p[1] }));
  const meta = tramos.reduce((a, b) => a + b, 0) * k;
  let andado = 0;
  for (let i = 0; i < tramos.length; i++) {
    if (andado + tramos[i]! >= meta) return puntos[i + 1]!;
    andado += tramos[i]!;
  }
  return puntos[puntos.length - 1]!;
}

/** Cuánto lugar (en píxeles de pantalla) deja el mojón a los pines y al auto: más cerca, los taparía. */
const MOJON_SEPARACION_PX = 70;

const KM_MOJON = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** El mojón: el número grande y la unidad abajo, como en la ruta. Solo cifras (no hay texto de afuera). */
function htmlMojon(metros: number): string {
  const [cifra, unidad] = metros < 1000 ? [String(Math.round(metros)), 'm'] : [KM_MOJON.format(metros / 1000), 'km'];
  return `<span class="mojon"><b>${cifra}</b><span>${unidad}</span></span>`;
}

/** El rumbo de `a` a `b`, en grados desde el norte, en el sentido de las agujas del reloj. */
function rumbo(a: Punto, b: Punto): number {
  const rad = (g: number) => (g * Math.PI) / 180;
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const sinMovimiento = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Un mapa de OpenStreetMap con Leaflet. La librería va en el bundle; lo único que viene de afuera son
 * las teselas (`img-src https://tile.openstreetmap.org` en la CSP de nginx). Nada en línea: Leaflet
 * posiciona con la CSSOM (`element.style` desde JS), que la CSP permite, y los colores salen de clases.
 *
 * - El auto es un ícono dibujado (visto desde arriba) que gira hacia donde maneja y avanza suave entre
 *   una posición y la siguiente (cada ~1 s), salvo con `prefers-reduced-motion`.
 * - `alTocar`: el pasajero marca un punto con un toque.
 * - Se encuadra solo cuando cambian el origen, el destino o la ruta, no con cada posición del auto: así
 *   no le saca el control a quien está mirando el mapa.
 */
export function Mapa({ marcas, alTocar, etiqueta }: { marcas: Marcas; alTocar?: (p: Punto) => void; etiqueta: string }) {
  const contenedor = useRef<HTMLDivElement>(null);
  const mapa = useRef<L.Map | null>(null);
  const capas = useRef<L.LayerGroup | null>(null);
  const auto = useRef<{ marcador: L.Marker; actual: Punto; rumbo: number; animacion: number | null } | null>(null);
  /** Vuelve a encuadrar el recorrido (lo llama el observador de tamaño). */
  const encuadre = useRef<(() => void) | null>(null);
  const alTocarRef = useRef(alTocar);
  alTocarRef.current = alTocar;

  useEffect(() => {
    if (!contenedor.current) return;
    const m = L.map(contenedor.current, { attributionControl: false, zoomControl: false }).setView([CENTRO_DEMO.lat, CENTRO_DEMO.lng], 14);
    // La página va con `Referrer-Policy: no-referrer`, pero la política de uso de OpenStreetMap pide
    // el Referer en las teselas: solo a ellas se les manda el origen (nunca la ruta).
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(m);
    L.control.zoom({ position: 'topright' }).addTo(m);
    // Sin el prefijo de Leaflet (lleva un SVG en línea): solo la atribución que pide OpenStreetMap.
    L.control
      .attribution({ prefix: false, position: 'topleft' })
      .addAttribution('© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>')
      .addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => alTocarRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    capas.current = L.layerGroup().addTo(m);
    mapa.current = m;
    // El contenedor cambia de tamaño con la grilla y con la hoja del celular.
    const observador = new ResizeObserver(() => {
      m.invalidateSize({ animate: false });
      encuadre.current?.();
    });
    observador.observe(contenedor.current);
    return () => {
      observador.disconnect();
      if (auto.current?.animacion) cancelAnimationFrame(auto.current.animacion);
      auto.current = null;
      m.remove();
      mapa.current = null;
      capas.current = null;
    };
  }, []);

  const { origen, destino, movil, movilVieja, persona, ruta, aproximacion, mojonMetros } = marcas;

  // Lo que no se mueve: la ruta, el tramo de aproximación, origen, destino y la otra persona.
  useEffect(() => {
    const grupo = capas.current;
    if (!grupo) return;
    grupo.clearLayers();
    const principal: L.LatLngExpression[] | null = ruta && ruta.length > 1 ? ruta : origen && destino ? [[origen.lat, origen.lng], [destino.lat, destino.lng]] : null;
    if (principal) {
      // Dos trazos: el borde blanco abajo, la ruta marina arriba. Recta (sin ruteo): punteada.
      const recta = !(ruta && ruta.length > 2);
      L.polyline(principal, { className: 'mapa-ruta-borde', interactive: false }).addTo(grupo);
      L.polyline(principal, { className: recta ? 'mapa-ruta recta' : 'mapa-ruta', interactive: false }).addTo(grupo);
    }
    if (aproximacion && aproximacion.length > 1) {
      L.polyline(aproximacion, { className: 'mapa-aproximacion', interactive: false }).addTo(grupo);
    }
    if (origen) L.circleMarker([origen.lat, origen.lng], { radius: 9, className: 'mapa-origen' }).bindTooltip('Origen').addTo(grupo);
    if (destino) L.circleMarker([destino.lat, destino.lng], { radius: 9, className: 'mapa-destino' }).bindTooltip('Destino').addTo(grupo);
    if (persona) {
      L.circleMarker([persona.lat, persona.lng], { radius: 14, className: 'mapa-persona halo', interactive: false }).addTo(grupo);
      L.circleMarker([persona.lat, persona.lng], { radius: 6, className: 'mapa-persona' }).bindTooltip('Pasajero').addTo(grupo);
    }
  }, [origen, destino, persona, ruta, aproximacion]);

  // El auto: un solo marcador que se mueve, gira y se apaga, sin rehacerse con cada posición.
  const mLat = movil?.lat;
  const mLng = movil?.lng;
  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    if (mLat === undefined || mLng === undefined) {
      if (auto.current) {
        if (auto.current.animacion) cancelAnimationFrame(auto.current.animacion);
        auto.current.marcador.remove();
        auto.current = null;
      }
      return;
    }
    const destinoAuto = { lat: mLat, lng: mLng };
    const a = auto.current;
    if (!a) {
      const icono = L.divIcon({ html: `<span class="mapa-auto-giro">${SVG_AUTO}</span>`, className: 'mapa-auto', iconSize: [40, 40], iconAnchor: [20, 20] });
      const marcador = L.marker([mLat, mLng], { icon: icono, keyboard: false, zIndexOffset: 1000 }).bindTooltip('Chofer').addTo(m);
      auto.current = { marcador, actual: destinoAuto, rumbo: 0, animacion: null };
      return;
    }
    // Gira hacia donde va, si se movió algo (con el auto quieto, el GPS baila unos metros).
    if (distanciaMetros(a.actual, destinoAuto) > 3) {
      a.rumbo = rumbo(a.actual, destinoAuto);
      const giro = a.marcador.getElement()?.querySelector<HTMLElement>('.mapa-auto-giro');
      if (giro) giro.style.transform = `rotate(${a.rumbo.toFixed(1)}deg)`;
    }
    if (a.animacion) cancelAnimationFrame(a.animacion);
    const desde = a.actual;
    // Un salto largo (se reconectó, otra fuente) no se anima: se va directo.
    if (sinMovimiento() || distanciaMetros(desde, destinoAuto) > 400) {
      a.marcador.setLatLng([mLat, mLng]);
      a.actual = destinoAuto;
      return;
    }
    const inicio = performance.now();
    const DURACION = 900;
    const paso = (t: number) => {
      const k = Math.min(1, (t - inicio) / DURACION);
      const punto = { lat: desde.lat + (destinoAuto.lat - desde.lat) * k, lng: desde.lng + (destinoAuto.lng - desde.lng) * k };
      a.marcador.setLatLng([punto.lat, punto.lng]);
      a.actual = punto;
      a.animacion = k < 1 ? requestAnimationFrame(paso) : null;
    };
    a.animacion = requestAnimationFrame(paso);
  }, [mLat, mLng]);

  useEffect(() => {
    auto.current?.marcador.getElement()?.classList.toggle('vieja', Boolean(movilVieja));
  }, [movilVieja, mLat, mLng]);

  // Encuadre: la ruta entera si la hay; si no, origen y destino; con uno solo, ese. Sin animación (dos
  // cambios seguidos dejaban el segundo a medio camino), y se repite si el mapa cambia de tamaño.
  const oLat = origen?.lat;
  const oLng = origen?.lng;
  const dLat = destino?.lat;
  const dLng = destino?.lng;
  const largoRuta = ruta?.length ?? 0;
  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    const puntos: L.LatLngTuple[] = [];
    if (oLat !== undefined && oLng !== undefined) puntos.push([oLat, oLng]);
    if (dLat !== undefined && dLng !== undefined) puntos.push([dLat, dLng]);
    if (ruta && ruta.length > 1) puntos.push(...ruta);
    const encuadrar = () => {
      m.invalidateSize({ animate: false });
      if (puntos.length >= 2) m.fitBounds(L.latLngBounds(puntos), { padding: [40, 40], maxZoom: 16, animate: false });
      else if (puntos.length === 1) m.setView(puntos[0]!, Math.max(m.getZoom(), 15), { animate: false });
    };
    encuadrar();
    encuadre.current = puntos.length > 0 ? encuadrar : null;
    // La ruta entra por su largo: una nueva con los mismos extremos encuadra igual.
  }, [oLat, oLng, dLat, dLng, largoRuta]);

  // El mojón, después del encuadre (necesita la vista final para medir en píxeles) y de nuevo con cada
  // zoom. Va en la mitad del tramo que importa (por distancia, no por cantidad de puntos), sobre la
  // misma línea; si ahí tapa un pin o el auto, un poco antes o después; si no hay lugar, no va.
  const posicionAuto = useRef<Punto | null>(null);
  posicionAuto.current = movil ?? null;
  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    const capa = L.layerGroup().addTo(m);
    const tramoMojon = aproximacion && aproximacion.length > 2 ? aproximacion : ruta && ruta.length > 2 ? ruta : null;
    const dibujar = () => {
      capa.clearLayers();
      if (!tramoMojon || mojonMetros == null || mojonMetros < MOJON_MINIMO_METROS) return;
      const ocupados = [origen, destino, persona, posicionAuto.current].filter((p): p is Punto => Boolean(p));
      const libre = (p: [number, number]) =>
        ocupados.every((o) => m.latLngToContainerPoint(p).distanceTo(m.latLngToContainerPoint([o.lat, o.lng])) >= MOJON_SEPARACION_PX);
      const punto = [0.5, 0.35, 0.65].map((k) => puntoDelTramo(tramoMojon, k)).find(libre);
      if (!punto) return;
      const icono = L.divIcon({ html: htmlMojon(mojonMetros), className: 'mapa-mojon', iconSize: [46, 52], iconAnchor: [23, 52] });
      L.marker(punto, { icon: icono, interactive: false, keyboard: false }).addTo(capa);
    };
    dibujar();
    m.on('zoomend', dibujar);
    return () => {
      m.off('zoomend', dibujar);
      capa.remove();
    };
  }, [origen, destino, persona, ruta, aproximacion, mojonMetros, largoRuta]);

  return <div ref={contenedor} className="mapa" role="application" aria-label={etiqueta} />;
}
