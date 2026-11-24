import type { Coordenada } from '../../dominio/entidades/index.js';
import type { ElegibilidadChoferes } from '../../dominio/puertos/index.js';
import type { MapaZonas } from '../zonas/mapa-zonas.js';
import type { PrismaClient } from './generated/client.js';
import { zonaDelPunto } from './repositorio-prisma.js';

/**
 * Zona del origen y filtro de candidatos en SQL (variante G). Lecturas sin lock, fuera de la
 * transacción de la oferta: pueden quedar viejas, y por eso la aceptación vuelve a validar con locks
 * (`TransaccionDespacho.choferAptoParaAceptar`).
 */
export class ElegibilidadPrisma implements ElegibilidadChoferes {
  constructor(private readonly prisma: PrismaClient) {}

  zonaDelOrigen(origen: Coordenada): Promise<string | null> {
    return zonaDelPunto(this.prisma, origen);
  }

  async aptos(ids: readonly string[], zonaId: string): Promise<string[]> {
    if (ids.length === 0) return [];
    // Una sola consulta para todo el lote: habilitado, activo, disponible, sin viaje activo y de una
    // flota con esta zona habilitada. El orden (el de location: del más cercano al más lejano) se
    // conserva afuera.
    const filas = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT d.id FROM drivers d
      JOIN fleet_zones fz ON fz.fleet_id = d.fleet_id AND fz.zone_id = ${zonaId}::uuid
      WHERE d.id = ANY(${[...ids]}::uuid[])
        AND d.approved AND d.active AND d.available
        AND NOT EXISTS (SELECT 1 FROM driver_active_assignment a WHERE a.driver_id = d.id)`;
    return enOrden(ids, filas);
  }

  /**
   * Como `aptos`, con las flotas de la zona ya resueltas (las del caché de zonas): no lee
   * `fleet_zones`. El estado de cada chofer (habilitado, activo, disponible, sin viaje) se lee igual
   * de Postgres: cambia todo el tiempo y no se cachea.
   */
  async aptosDeFlotas(ids: readonly string[], flotas: readonly string[]): Promise<string[]> {
    if (ids.length === 0 || flotas.length === 0) return [];
    const filas = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT d.id FROM drivers d
      WHERE d.id = ANY(${[...ids]}::uuid[])
        AND d.fleet_id = ANY(${[...flotas]}::uuid[])
        AND d.approved AND d.active AND d.available
        AND NOT EXISTS (SELECT 1 FROM driver_active_assignment a WHERE a.driver_id = d.id)`;
    return enOrden(ids, filas);
  }

  /**
   * Todas las zonas, con su polígono y las flotas que operan en cada una, para el caché de zonas. Una
   * sola consulta: una foto coherente aunque alguien esté cambiando zonas a la vez.
   */
  async mapaDeZonas(): Promise<MapaZonas> {
    const filas = await this.prisma.$queryRaw<{ id: string; area: string; flotas: string[] }[]>`
      SELECT z.id::text AS id, ST_AsGeoJSON(z.area) AS area,
             COALESCE(array_agg(fz.fleet_id::text ORDER BY fz.fleet_id) FILTER (WHERE fz.fleet_id IS NOT NULL), '{}') AS flotas
      FROM zones z
      LEFT JOIN fleet_zones fz ON fz.zone_id = z.id
      GROUP BY z.id
      ORDER BY z.id`;
    return {
      zonas: filas.map((f) => ({
        id: f.id,
        anillos: (JSON.parse(f.area) as { coordinates: [number, number][][] }).coordinates,
        flotas: f.flotas,
      })),
    };
  }
}

/** Los aptos, en el orden en que llegaron los ids. */
function enOrden(ids: readonly string[], filas: { id: string }[]): string[] {
  const aptos = new Set(filas.map((f) => f.id));
  return ids.filter((id) => aptos.has(id));
}
