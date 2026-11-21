import { randomUUID } from 'node:crypto';
import { idempotenciaPendiente, idempotenciaRegistrada, requestIdActual } from '@viajes/platform';
import {
  Cobro,
  Oferta,
  SolicitudViaje,
  type EstadoCobro,
  type EstadoOferta,
  type EstadoSolicitud,
  type MotivoDiferencia,
  type TarifaViaje,
} from '../../dominio/entidades/index.js';
import type {
  FiltroSolicitudes,
  Pagina,
  RepositorioDespacho,
  TransaccionDespacho,
} from '../../dominio/puertos/index.js';
import { Prisma, type PrismaClient } from './generated/client.js';
import { registrarEnTransaccion } from './idempotencia-prisma.js';
import { destinatariosDe } from '../tiempo-real/tipos.js';

interface FilaSolicitud {
  id: string;
  passenger_id: string;
  status: string;
  origin_lat: number;
  origin_lng: number;
  destination_lat: number;
  destination_lng: number;
  driver_id: string | null;
  cancel_reason: string | null;
  fare_version: string | null;
  estimated_fare_cents: number | null;
  estimated_distance_m: number | null;
  estimated_duration_s: number | null;
  final_fare_cents: number | null;
  final_distance_m: number | null;
  final_duration_s: number | null;
  fare_difference_reasons: string[];
  started_at: Date | null;
  version: number;
  created_at: Date;
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
  motivoCancelacion: string | null;
  tarifaVersion: string | null;
  estimadaCentavos: number | null;
  estimadaMetros: number | null;
  estimadaSegundos: number | null;
  finalCentavos: number | null;
  finalMetros: number | null;
  finalSegundos: number | null;
  motivosDiferencia: string[];
  iniciadoEn: Date | null;
  version: number;
  creadaEn: Date;
};

type ModeloOferta = { id: string; solicitudId: string; choferId: string; estado: string; venceEn: Date };

type ModeloCobro = {
  id: string;
  solicitudId: string;
  pasajeroId: string;
  montoCentavos: number;
  estado: string;
  intentosFallidos: number;
  referencia: string | null;
  motivoRechazo: string | null;
};

/** Las columnas de la tarifa → el objeto del dominio. Sin versión, es una solicitud de antes de guardarla. */
function aTarifa(m: ModeloSolicitud): TarifaViaje | null {
  if (m.tarifaVersion === null) return null;
  return {
    version: m.tarifaVersion,
    moneda: 'ARS',
    estimadaCentavos: m.estimadaCentavos as number,
    recorridoEstimado: { metros: m.estimadaMetros as number, segundos: m.estimadaSegundos as number },
    finalCentavos: m.finalCentavos,
    recorridoFinal:
      m.finalMetros === null || m.finalSegundos === null ? null : { metros: m.finalMetros, segundos: m.finalSegundos },
    motivosDiferencia: m.motivosDiferencia as MotivoDiferencia[],
  };
}

function aSolicitud(m: ModeloSolicitud): SolicitudViaje {
  return SolicitudViaje.reconstruir({
    id: m.id,
    pasajeroId: m.pasajeroId,
    estado: m.estado as EstadoSolicitud,
    origen: { lat: m.origenLat, lng: m.origenLng },
    destino: { lat: m.destinoLat, lng: m.destinoLng },
    choferId: m.choferId,
    motivoCancelacion: m.motivoCancelacion,
    tarifa: aTarifa(m),
    version: m.version,
    creadaEn: m.creadaEn,
    iniciadoEn: m.iniciadoEn,
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
    motivoCancelacion: f.cancel_reason,
    tarifaVersion: f.fare_version,
    estimadaCentavos: f.estimated_fare_cents,
    estimadaMetros: f.estimated_distance_m,
    estimadaSegundos: f.estimated_duration_s,
    finalCentavos: f.final_fare_cents,
    finalMetros: f.final_distance_m,
    finalSegundos: f.final_duration_s,
    motivosDiferencia: f.fare_difference_reasons,
    iniciadoEn: f.started_at,
    version: f.version,
    creadaEn: f.created_at,
  });
}

function aOferta(m: ModeloOferta): Oferta {
  return Oferta.reconstruir({ ...m, estado: m.estado as EstadoOferta });
}

function aCobro(m: ModeloCobro): Cobro {
  return Cobro.reconstruir({
    id: m.id,
    solicitudId: m.solicitudId,
    pasajeroId: m.pasajeroId,
    montoCentavos: m.montoCentavos,
    moneda: 'ARS',
    estado: m.estado as EstadoCobro,
    intentosFallidos: m.intentosFallidos,
    referencia: m.referencia,
    motivoRechazo: m.motivoRechazo,
  });
}

const COLUMNAS_SOLICITUD = Prisma.sql`id, passenger_id, status, origin_lat, origin_lng, destination_lat, destination_lng,
  driver_id, cancel_reason, fare_version, estimated_fare_cents, estimated_distance_m, estimated_duration_s,
  final_fare_cents, final_distance_m, final_duration_s, fare_difference_reasons, started_at, version, created_at`;

/** Para LIKE: el texto del usuario se busca tal cual, sin que `%` o `_` funcionen como comodines. */
const escaparLike = (texto: string) => texto.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Arma el WHERE con fragmentos de Prisma.sql: cada valor viaja como parámetro ($1, $2...),
 * nunca concatenado al SQL. Por eso una búsqueda como `' OR '1'='1` es solo texto.
 */
function condicionesListado({ pasajeroId, choferId, estados, texto }: FiltroSolicitudes): Prisma.Sql {
  const condiciones: Prisma.Sql[] = [];
  if (pasajeroId) condiciones.push(Prisma.sql`passenger_id = ${pasajeroId}::uuid`);
  if (choferId) condiciones.push(Prisma.sql`driver_id = ${choferId}::uuid`);
  if (estados) condiciones.push(estados.length ? Prisma.sql`status IN (${Prisma.join(estados)})` : Prisma.sql`FALSE`);
  if (texto) {
    // La barra invertida es el escape por defecto de LIKE/ILIKE en Postgres.
    const patron = `%${escaparLike(texto)}%`;
    condiciones.push(Prisma.sql`(id::text ILIKE ${patron} OR passenger_id::text ILIKE ${patron}
      OR driver_id::text ILIKE ${patron} OR cancel_reason ILIKE ${patron})`);
  }
  return condiciones.length ? Prisma.sql`WHERE ${Prisma.join(condiciones, ' AND ')}` : Prisma.empty;
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
        SELECT ${COLUMNAS_SOLICITUD}
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
      // created_at sale del Reloj del dominio (antes de buscar candidatos), no del now() de la base.
      const t = s.tarifa;
      const filas = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO ride_requests (id, passenger_id, status, origin_lat, origin_lng, destination_lat, destination_lng,
                                   fare_version, estimated_fare_cents, estimated_distance_m, estimated_duration_s,
                                   version, created_at)
        VALUES (${s.id}::uuid, ${s.pasajeroId}::uuid, ${s.estado},
                ${s.origen.lat}::float8, ${s.origen.lng}::float8, ${s.destino.lat}::float8, ${s.destino.lng}::float8,
                ${t?.version ?? null}, ${t?.estimadaCentavos ?? null}::int,
                ${t?.recorridoEstimado.metros ?? null}::int, ${t?.recorridoEstimado.segundos ?? null}::int,
                ${s.version}, ${s.creadaEn}::timestamptz)
        ON CONFLICT DO NOTHING
        RETURNING id`;
      return filas.length === 1;
    },

    async guardarSolicitud(s) {
      // La estimación no cambia nunca después de crear la solicitud: solo se escriben la final y el inicio.
      const { tarifa, iniciadoEn } = s.aRegistro();
      await tx.solicitudViaje.update({
        where: { id: s.id },
        data: {
          estado: s.estado,
          choferId: s.choferId,
          motivoCancelacion: s.motivoCancelacion,
          finalCentavos: tarifa?.finalCentavos ?? null,
          finalMetros: tarifa?.recorridoFinal?.metros ?? null,
          finalSegundos: tarifa?.recorridoFinal?.segundos ?? null,
          motivosDiferencia: tarifa?.motivosDiferencia ?? [],
          iniciadoEn,
          version: s.version,
          actualizadaEn: new Date(),
        },
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
          // A quién se le entrega por SSE: el pasajero y el chofer del payload.
          destinatarios: destinatariosDe(evento.payload as Record<string, unknown>),
        },
      });
    },

    async insertarCobro(c) {
      // request_id es único: si por un error de programación se intentara un segundo cobro del mismo
      // viaje, la base lo rechaza y la transacción entera (la finalización) se deshace.
      await tx.cobro.create({
        data: { id: c.id, solicitudId: c.solicitudId, pasajeroId: c.pasajeroId, montoCentavos: c.montoCentavos },
      });
    },

    async obtenerCobroParaActualizar(solicitudId) {
      // Igual que la solicitud: el segundo proceso que quiera registrar un resultado espera acá.
      const filas = await tx.$queryRaw<ModeloCobro[]>`
        SELECT id, request_id AS "solicitudId", passenger_id AS "pasajeroId", amount_cents AS "montoCentavos",
               status AS estado, failed_attempts AS "intentosFallidos", provider_ref AS referencia,
               decline_reason AS "motivoRechazo"
        FROM payments
        WHERE request_id = ${solicitudId}::uuid
        FOR UPDATE`;
      return filas[0] ? aCobro(filas[0]) : null;
    },

    async guardarCobro(c) {
      const d = c.aDatos();
      await tx.cobro.update({
        where: { id: d.id },
        data: { estado: d.estado, referencia: d.referencia, motivoRechazo: d.motivoRechazo, actualizadoEn: new Date() },
      });
    },
  };
}

export class RepositorioDespachoPrisma implements RepositorioDespacho {
  constructor(private readonly prisma: PrismaClient) {}

  async enTransaccion<T>(trabajo: (tx: TransaccionDespacho) => Promise<T>): Promise<T> {
    // Si el pedido HTTP trae Idempotency-Key, el registro va en esta misma transacción.
    const idempotencia = idempotenciaPendiente();
    const resultado = await this.prisma.$transaction(
      async (tx) => {
        const r = await trabajo(transaccion(tx));
        if (idempotencia) await registrarEnTransaccion(tx, idempotencia, r);
        return r;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        // Con muchas aceptaciones simultáneas, varias esperan el lock y una conexión libre del pool.
        maxWait: 10_000,
        timeout: 10_000,
      },
    );
    if (idempotencia) idempotenciaRegistrada();
    return resultado;
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

  async listarSolicitudes(filtro: FiltroSolicitudes, { limite, desde }: Pagina) {
    const filas = await this.prisma.$queryRaw<FilaSolicitud[]>`
      SELECT ${COLUMNAS_SOLICITUD}
      FROM ride_requests
      ${condicionesListado(filtro)}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limite}::int OFFSET ${desde}::int`;
    return filas.map(filaASolicitud);
  }

  async obtenerCobro(solicitudId: string) {
    const m = await this.prisma.cobro.findUnique({ where: { solicitudId } });
    return m ? aCobro(m) : null;
  }

  async cobrosPendientes(limite: number) {
    const filas = await this.prisma.cobro.findMany({
      where: { estado: 'PENDIENTE' },
      orderBy: { creadoEn: 'asc' },
      select: { solicitudId: true },
      take: limite,
    });
    return filas.map((f) => f.solicitudId);
  }

  async registrarFalloCobro(cobroId: string, motivo: string) {
    // Solo si sigue pendiente: un fallo que llega tarde no toca un cobro ya resuelto.
    await this.prisma.cobro.updateMany({
      where: { id: cobroId, estado: 'PENDIENTE' },
      data: { intentosFallidos: { increment: 1 }, ultimoError: motivo.slice(0, 500), actualizadoEn: new Date() },
    });
  }
}
