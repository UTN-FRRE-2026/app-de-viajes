import type { Coordenada } from '../../dominio/entidades/index.js';
import type { ElegibilidadChoferes } from '../../dominio/puertos/index.js';
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
    const aptos = new Set(filas.map((f) => f.id));
    return ids.filter((id) => aptos.has(id));
  }
}
