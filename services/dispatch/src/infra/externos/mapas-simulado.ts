import type { Coordenada } from '../../dominio/entidades/index.js';
import type { Recorrido } from '../../dominio/tarifas/calculo.js';
import type { ServicioMapas } from '../../dominio/puertos/index.js';

const RADIO_TIERRA_METROS = 6_371_008.8;
const rad = (grados: number) => (grados * Math.PI) / 180;

/**
 * Distancia en línea recta sobre la superficie terrestre (haversine). Es la misma cuenta que usa
 * location; se repite acá porque dispatch no puede importar el dominio de otro servicio.
 */
export function distanciaRectaMetros(a: Coordenada, b: Coordenada): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_METROS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface OpcionesMapasSimulado {
  /** Cuánto más largo que la línea recta es el recorrido por calles (por ejemplo, 1,3). */
  factorDesvio: number;
  velocidadKmh: number;
  /** Demora artificial, para demostrar el timeout. 0 en uso normal. */
  latenciaMs?: number;
}

/**
 * Mapas sin proveedor externo: una **aproximación**, no un ruteo real. Recorrido = línea recta ×
 * factor de desvío; tiempo = recorrido a velocidad media constante. Devuelve enteros.
 */
export class MapasSimulado implements ServicioMapas {
  constructor(private readonly opciones: OpcionesMapasSimulado) {}

  async recorrido(origen: Coordenada, destino: Coordenada): Promise<Recorrido> {
    const { factorDesvio, velocidadKmh, latenciaMs = 0 } = this.opciones;
    if (latenciaMs > 0) await new Promise((r) => setTimeout(r, latenciaMs));
    const metros = Math.round(distanciaRectaMetros(origen, destino) * factorDesvio);
    const segundos = Math.round((metros * 3.6) / velocidadKmh);
    return { metros, segundos };
  }
}
