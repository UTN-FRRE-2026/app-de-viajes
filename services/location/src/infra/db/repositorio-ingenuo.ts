import { seleccionarCercanos, type Cercano, type Ping } from '../../dominio/entidades/index.js';
import type { BusquedaCercanos, RepositorioUbicaciones } from '../../dominio/puertos/index.js';
import type { PrismaClient } from './generated/client.js';

interface FilaUltimaPosicion {
  driver_id: string;
  lat: number;
  lng: number;
  recorded_at: Date;
}

/**
 * Versión ingenua de 6.6, la línea de base para medir con k6:
 * - cada ping es un INSERT, aunque el chofer mande uno cada 2 s;
 * - cada búsqueda trae la última posición de TODOS los choferes vigentes y calcula la distancia
 *   en JavaScript, en el event loop. No hay índice geográfico.
 */
export class RepositorioUbicacionesIngenuo implements RepositorioUbicaciones {
  constructor(private readonly prisma: PrismaClient) {}

  async guardar({ choferId, posicion, registradoEn }: Ping): Promise<void> {
    await this.prisma.ping.create({ data: { choferId, lat: posicion.lat, lng: posicion.lng, registradoEn } });
  }

  async cercanos({ origen, radioMetros, limite, desde }: BusquedaCercanos): Promise<Cercano[]> {
    // DISTINCT ON usa el índice (driver_id, recorded_at DESC). A igual hora, gana el último insertado.
    const filas = await this.prisma.$queryRaw<FilaUltimaPosicion[]>`
      SELECT DISTINCT ON (driver_id) driver_id, lat, lng, recorded_at
      FROM pings
      WHERE recorded_at >= ${desde}
      ORDER BY driver_id, recorded_at DESC, id DESC`;
    const posiciones = filas.map((f) => ({
      choferId: f.driver_id,
      posicion: { lat: f.lat, lng: f.lng },
      registradoEn: f.recorded_at,
    }));
    return seleccionarCercanos(posiciones, origen, { radioMetros, limite });
  }
}
