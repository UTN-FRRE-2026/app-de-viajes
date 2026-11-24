import type { EstadoSolicitud } from '@viajes/contracts';

// Lo que comparten las pantallas de un viaje (chofer y pasajero). Los tipos de las respuestas salen de
// @viajes/contracts, solo como tipos: zod no entra en el bundle.
export type { OfertaPendiente, SolicitudRespuesta as Solicitud, EstadoChoferRespuesta } from '@viajes/contracts';

export const ETIQUETA_ESTADO: Record<EstadoSolicitud, string> = {
  BUSCANDO: 'Buscando chofer',
  ASIGNADO: 'Asignado',
  EN_CAMINO: 'Chofer en camino',
  EN_CURSO: 'En viaje',
  COMPLETADA: 'Terminado',
  CANCELADO_PASAJERO: 'Cancelado por el pasajero',
  CANCELADO_CHOFER: 'Cancelado por el chofer',
  CANCELADO_OPERADOR: 'Cancelado por el operador',
  SIN_CHOFERES: 'Sin choferes disponibles',
};

/** Los estados con chofer en los que el viaje sigue: mientras tanto, cada uno ve la posición del otro. */
export const ESTADOS_CON_CHOFER: readonly EstadoSolicitud[] = ['ASIGNADO', 'EN_CAMINO', 'EN_CURSO'];

const PESOS = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });
export const pesos = (centavos: number) => PESOS.format(centavos / 100);

export interface Punto {
  lat: number;
  lng: number;
}

/** Distancia en línea recta (haversine), en metros. */
export function distanciaMetros(a: Punto, b: Punto): number {
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

const KM = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
/** «650 m», «6,2 km»: con coma decimal, como los importes. */
export const textoDistancia = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${KM.format(m / 1000)} km`);
export const textoPunto = (p: Punto) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
