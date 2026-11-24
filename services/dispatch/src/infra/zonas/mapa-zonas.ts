import { z } from 'zod';
import type { Coordenada } from '../../dominio/entidades/index.js';

type Punto = [number, number];

/**
 * Lo que se guarda en el caché: todas las zonas, con sus polígonos (anillos de pares [lng, lat], como
 * GeoJSON) y las flotas que tienen cada una habilitada. Ordenadas por id. Sale de una sola consulta a
 * Postgres (`ElegibilidadPrisma.mapaDeZonas`), así que es una foto coherente.
 */
export interface MapaZonas {
  zonas: ZonaDelMapa[];
}

export interface ZonaDelMapa {
  id: string;
  /** El anillo exterior y, si los hubiera, los huecos. */
  anillos: Punto[][];
  /** Las flotas que operan en la zona (`fleet_zones`). */
  flotas: string[];
}

/** Lo que vuelve de Redis se valida: una entrada rota cuenta como MISS. */
export const EsquemaMapaZonas = z.object({
  zonas: z.array(
    z.object({
      id: z.string().min(1),
      anillos: z.array(z.array(z.tuple([z.number(), z.number()])).min(4)).min(1),
      flotas: z.array(z.string().min(1)),
    }),
  ),
});

/**
 * Margen, en grados (unos 11 mm de latitud). Un punto a menos de esto de algún lado de alguna zona
 * se resuelve con PostGIS: ahí se decide el borde (ST_Covers lo incluye, y en un borde compartido gana
 * la zona de menor id), y la geometría de Postgres y la de JavaScript podrían no coincidir por
 * redondeo (ST_AsGeoJSON devuelve 9 decimales). Lejos de los bordes, las dos dan lo mismo.
 */
export const MARGEN_BORDE = 1e-7;

function distanciaAlLado(p: Punto, a: Punto, b: Punto): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const largo2 = dx * dx + dy * dy;
  const t = largo2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / largo2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Rayo horizontal sobre todos los anillos (par/impar: un hueco resta). `cerca` si el punto está a
 * menos de `margen` de algún lado: ahí no se decide en JavaScript. Lejos de todos los lados, la
 * distancia horizontal a cada lado es como mínimo el margen, así que el redondeo no cambia el resultado.
 */
export function ubicarEnZona(p: Punto, anillos: Punto[][], margen = MARGEN_BORDE): 'adentro' | 'afuera' | 'cerca' {
  let adentro = false;
  for (const anillo of anillos) {
    for (let i = 0; i + 1 < anillo.length; i++) {
      const a = anillo[i]!;
      const b = anillo[i + 1]!;
      if (distanciaAlLado(p, a, b) <= margen) return 'cerca';
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) adentro = !adentro;
    }
  }
  return adentro ? 'adentro' : 'afuera';
}

/**
 * La zona que cubre el origen según el mapa, o `dudoso` si está cerca de un borde (lo decide PostGIS).
 * Las zonas no comparten interior: un punto que está claramente adentro de una está afuera de las
 * demás (si estuviera en el borde de otra, sería `dudoso`).
 */
export function zonaEnMapa(mapa: MapaZonas, { lat, lng }: Coordenada): { zonaId: string | null } | 'dudoso' {
  let encontrada: string | null = null;
  for (const zona of mapa.zonas) {
    const r = ubicarEnZona([lng, lat], zona.anillos);
    if (r === 'cerca') return 'dudoso';
    if (r === 'adentro' && (encontrada === null || zona.id < encontrada)) encontrada = zona.id;
  }
  return { zonaId: encontrada };
}
