import type { Logger } from '@viajes/platform';
import type { Coordenada } from '../../dominio/entidades/index.js';
import type { ElegibilidadChoferes } from '../../dominio/puertos/index.js';
import type { ResultadoCache } from '../tarifas/proveedor-tarifas.js';
import type { CacheZonas } from './cache-zonas.js';
import { zonaEnMapa, type MapaZonas } from './mapa-zonas.js';

/** Lo que pone Postgres (`ElegibilidadPrisma`): las consultas de siempre, y las que usan el mapa. */
export interface ElegibilidadConMapa extends ElegibilidadChoferes {
  mapaDeZonas(): Promise<MapaZonas>;
  aptosDeFlotas(ids: readonly string[], flotas: readonly string[]): Promise<string[]>;
}

export interface OpcionesElegibilidadConCache {
  base: ElegibilidadConMapa;
  cache: CacheZonas;
  logger: Logger;
  /** Para las métricas: HIT, MISS o error del caché. */
  alLeerCache?: (resultado: ResultadoCache) => void;
}

/**
 * Caché de zonas (docs/flotas.md): acelera la búsqueda previa a la oferta, nada más.
 * - **Zona del origen:** con los polígonos del mapa, en vez de ST_Covers en PostGIS. Cerca de un borde
 *   (o si el mapa no está) se pregunta a PostGIS, que es quien decide el borde.
 * - **Filtro de candidatos:** las flotas de la zona salen del mapa; el estado de cada chofer se lee
 *   de Postgres, como siempre. Una zona sin flotas no consulta la base.
 * - **La aceptación no pasa por acá:** revalida al chofer y la zona de su flota con Postgres, con
 *   locks, dentro de su transacción. Un mapa viejo puede hacer que se ofrezca a alguien que ya no
 *   puede aceptar (y la aceptación lo rechaza), nunca que se asigne.
 * - Si Redis falla o tarda, se usa Postgres: el caché nunca es un punto de falla.
 */
export class ElegibilidadConCache implements ElegibilidadChoferes {
  constructor(private readonly o: OpcionesElegibilidadConCache) {}

  async zonaDelOrigen(origen: Coordenada): Promise<string | null> {
    const mapa = await this.mapa();
    if (mapa) {
      const r = zonaEnMapa(mapa, origen);
      if (r !== 'dudoso') return r.zonaId;
    }
    return this.o.base.zonaDelOrigen(origen);
  }

  async aptos(ids: readonly string[], zonaId: string): Promise<string[]> {
    if (ids.length === 0) return [];
    const zona = (await this.mapa())?.zonas.find((z) => z.id === zonaId);
    // Sin mapa, o una zona que el mapa no tiene: la consulta de siempre.
    if (!zona) return this.o.base.aptos(ids, zonaId);
    // Ninguna flota opera en la zona: nadie es apto, sin preguntarle a la base.
    if (zona.flotas.length === 0) return [];
    return this.o.base.aptosDeFlotas(ids, zona.flotas);
  }

  /** Después del COMMIT de un cambio de zonas: una generación nueva. Si falla, queda el TTL. */
  async zonasCambiadas(): Promise<void> {
    try {
      await this.o.cache.invalidar();
    } catch (err) {
      this.avisar('invalidación', err);
    }
  }

  /** El mapa de Redis (HIT) o de Postgres (MISS, y se guarda). null si Redis falló: se usa Postgres. */
  private async mapa(): Promise<MapaZonas | null> {
    let generacion: string;
    try {
      const leido = await this.o.cache.leer();
      this.o.alLeerCache?.(leido.mapa ? 'hit' : 'miss');
      if (leido.mapa) return leido.mapa;
      generacion = leido.generacion;
    } catch (err) {
      this.o.alLeerCache?.('error');
      this.avisar('lectura', err);
      return null;
    }
    // Postgres se lee DESPUÉS de la generación: lo que se guarda con ella no es más viejo que ella.
    const mapa = await this.o.base.mapaDeZonas();
    await this.o.cache.guardar(generacion, mapa).catch((err: unknown) => this.avisar('escritura', err));
    return mapa;
  }

  private avisar(que: string, err: unknown) {
    this.o.logger.warn({ err: err instanceof Error ? err.message : String(err) }, `zonas: falló la ${que} del caché; se usa Postgres`);
  }
}
