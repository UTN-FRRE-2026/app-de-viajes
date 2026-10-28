import { randomUUID } from 'node:crypto';
import { requestIdActual } from '@viajes/platform';
import {
  Oferta,
  SolicitudViaje,
  type EstadoOferta,
  type EstadoSolicitud,
} from '../../dominio/entidades/index.js';
import type { RepositorioDespacho, TransaccionDespacho } from '../../dominio/puertos/index.js';
import { Prisma, type PrismaClient } from './generated/client.js';

interface FilaSolicitud {
  id: string;
  passenger_id: string;
  status: string;
  origin_lat: number;
  origin_lng: number;
  destination_lat: number;
  destination_lng: number;
  driver_id: string | null;
  version: number;
}

type ModeloSolicitud = {
  id: string;
  pasajeroId: string;
  estado: string;
  origenLat: number;
  origenLng: number;
  destinoLat: number;
  destinoLng: number;
  choferId: string | null;
  version: number;
};

type ModeloOferta = { id: string; solicitudId: string; choferId: string; estado: string; venceEn: Date };

function aSolicitud(m: ModeloSolicitud): SolicitudViaje {
  return SolicitudViaje.reconstruir({
    id: m.id,
    pasajeroId: m.pasajeroId,
    estado: m.estado as EstadoSolicitud,
    origen: { lat: m.origenLat, lng: m.origenLng },
    destino: { lat: m.destinoLat, lng: m.destinoLng },
    choferId: m.choferId,
    version: m.version,
  });
}

function filaASolicitud(f: FilaSolicitud): SolicitudViaje {
  return aSolicitud({
    id: f.id,
    pasajeroId: f.passenger_id,
    estado: f.status,
    origenLat: f.origin_lat,
    origenLng: f.origin_lng,
    destinoLat: f.destination_lat,
    destinoLng: f.destination_lng,
    choferId: f.driver_id,
    version: f.version,
  });
}

function aOferta(m: ModeloOferta): Oferta {
  return Oferta.reconstruir({ ...m, estado: m.estado as EstadoOferta });
}

/**
 * Las garantías de concurrencia del problema 6.3 viven en este archivo, en SQL:
 * el FOR UPDATE de la solicitud, la restricción única del chofer y el índice parcial del pasajero.
 * Con DISPATCH_LOG_SQL=1 se ven en el log.
 */
function transaccion(tx: Prisma.TransactionClient): TransaccionDespacho {
  return {
    async obtenerSolicitudParaActualizar(id) {
      // Bloquea la fila hasta COMMIT/ROLLBACK. Otra transacción que pida el mismo lock espera acá.
      const filas = await tx.$queryRaw<FilaSolicitud[]>`
        SELECT id, passenger_id, status, origin_lat, origin_lng, destination_lat, destination_lng, driver_id, version
        FROM ride_requests
        WHERE id = ${id}::uuid
        FOR UPDATE`;
      return filas[0] ? filaASolicitud(filas[0]) : null;
    },

    async ofertasDeSolicitud(solicitudId) {
      const filas = await tx.oferta.findMany({ where: { solicitudId }, orderBy: { creadaEn: 'asc' } });
      return filas.map(aOferta);
    },

    async insertarSolicitud(s) {
      // Si el pasajero ya tiene una activa, el índice único parcial lo impide y no se inserta nada.
      // ON CONFLICT DO NOTHING en vez de capturar el error: la transacción no queda abortada.
      const filas = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO ride_requests (id, passenger_id, status, origin_lat, origin_lng, destination_lat, destination_lng, version)
        VALUES (${s.id}::uuid, ${s.pasajeroId}::uuid, ${s.estado},
                ${s.origen.lat}::float8, ${s.origen.lng}::float8, ${s.destino.lat}::float8, ${s.destino.lng}::float8,
                ${s.version})
        ON CONFLICT DO NOTHING
        RETURNING id`;
      return filas.length === 1;
    },

    async guardarSolicitud(s) {
      await tx.solicitudViaje.update({
        where: { id: s.id },
        data: { estado: s.estado, choferId: s.choferId, version: s.version, actualizadaEn: new Date() },
      });
    },

    async guardarOfertas(ofertas) {
      if (ofertas.length === 0) return;
      const valores = ofertas.map(
        (o) => Prisma.sql`(${o.id}::uuid, ${o.solicitudId}::uuid, ${o.choferId}::uuid, ${o.estado}, ${o.venceEn}::timestamptz)`,
      );
      await tx.$executeRaw`
        INSERT INTO offers (id, request_id, driver_id, status, expires_at)
        VALUES ${Prisma.join(valores)}
        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`;
    },

    async reservarChofer(choferId, solicitudId) {
      // driver_id es la clave primaria (única). Si otra transacción insertó el mismo chofer y
      // todavía no confirmó, Postgres hace ESPERAR a esta hasta que la otra termine:
      //  - si la otra confirmó → conflicto → 0 filas → el chofer ya tiene viaje activo;
      //  - si la otra hizo rollback → esta inserta normalmente.
      const filas = await tx.$queryRaw<{ driver_id: string }[]>`
        INSERT INTO driver_active_assignment (driver_id, request_id)
        VALUES (${choferId}::uuid, ${solicitudId}::uuid)
        ON CONFLICT DO NOTHING
        RETURNING driver_id`;
      return filas.length === 1;
    },

    async liberarChofer(solicitudId) {
      await tx.asignacionActiva.deleteMany({ where: { solicitudId } });
    },

    async registrarEvento(evento) {
      await tx.eventoOutbox.create({
        data: {
          id: randomUUID(),
          tipo: evento.tipo,
          payload: evento.payload as Prisma.InputJsonObject,
          requestId: requestIdActual() ?? null,
        },
      });
    },
  };
}

export class RepositorioDespachoPrisma implements RepositorioDespacho {
  constructor(private readonly prisma: PrismaClient) {}

  enTransaccion<T>(trabajo: (tx: TransaccionDespacho) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => trabajo(transaccion(tx)), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      // Con muchas aceptaciones simultáneas, varias esperan el lock y una conexión libre del pool.
      maxWait: 10_000,
      timeout: 10_000,
    });
  }

  async obtenerSolicitud(id: string) {
    const m = await this.prisma.solicitudViaje.findUnique({ where: { id } });
    return m ? aSolicitud(m) : null;
  }

  async obtenerOferta(id: string) {
    const m = await this.prisma.oferta.findUnique({ where: { id } });
    return m ? aOferta(m) : null;
  }

  async solicitudesConOfertasVencidas(ahora: Date, limite: number) {
    const filas = await this.prisma.oferta.findMany({
      where: { estado: 'PENDIENTE', venceEn: { lte: ahora } },
      distinct: ['solicitudId'],
      select: { solicitudId: true },
      take: limite,
    });
    return filas.map((f) => f.solicitudId);
  }

  async choferesOfrecidos(solicitudId: string) {
    const filas = await this.prisma.oferta.findMany({ where: { solicitudId }, select: { choferId: true } });
    return filas.map((f) => f.choferId);
  }
}
