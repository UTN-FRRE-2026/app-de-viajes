import { randomUUID } from 'node:crypto';
import { idempotenciaPendiente, idempotenciaRegistrada, registrarIdempotenciaEnTransaccion, requestIdActual } from '@viajes/platform';
import {
  Cobro,
  ESTADOS_CON_CHOFER,
  Oferta,
  SolicitudViaje,
  type EstadoCobro,
  type EstadoOferta,
  type EstadoSolicitud,
  type MotivoDiferencia,
  type TarifaViaje,
} from '../../dominio/entidades/index.js';
import type {
  DatosReporteFlota,
  FiltroSolicitudes,
  Pagina,
  PeriodoReporte,
  RepositorioDespacho,
  TransaccionDespacho,
} from '../../dominio/puertos/index.js';
import { Prisma, type PrismaClient } from './generated/client.js';
import { totalCentavos } from './importes.js';
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
  estimated_fare_cents: Importe | null;
  estimated_distance_m: number | null;
  estimated_duration_s: number | null;
  final_fare_cents: Importe | null;
  final_distance_m: number | null;
  final_duration_s: number | null;
  fare_difference_reasons: string[];
  started_at: Date | null;
  version: number;
  created_at: Date;
  zone_id: string | null;
  fleet_id: string | null;
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
  estimadaCentavos: Importe | null;
  estimadaMetros: number | null;
  estimadaSegundos: number | null;
  finalCentavos: Importe | null;
  finalMetros: number | null;
  finalSegundos: number | null;
  motivosDiferencia: string[];
  iniciadoEn: Date | null;
  version: number;
  creadaEn: Date;
  zonaId: string | null;
  flotaId: string | null;
};

type ModeloOferta = { id: string; solicitudId: string; choferId: string; estado: string; venceEn: Date };

type ModeloCobro = {
  id: string;
  solicitudId: string;
  pasajeroId: string;
  montoCentavos: Importe;
  estado: string;
  intentosFallidos: number;
  referencia: string | null;
  motivoRechazo: string | null;
};

/**
 * Los importes van en BIGINT: con una tarifa alta que el admin puede configurar, un total pasa el
 * máximo de INTEGER (unos $21 millones). Prisma los devuelve como `bigint`; el dominio usa `number`,
 * que alcanza porque `calcularTarifa` nunca devuelve más que `Number.MAX_SAFE_INTEGER`.
 */
type Importe = bigint | number;

function aCentavos(v: Importe): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`importe fuera de rango: ${v}`);
  return n;
}

/** Las columnas de la tarifa → el objeto del dominio. Sin versión, es una solicitud de antes de guardarla. */
function aTarifa(m: ModeloSolicitud): TarifaViaje | null {
  if (m.tarifaVersion === null) return null;
  return {
    version: m.tarifaVersion,
    moneda: 'ARS',
    estimadaCentavos: aCentavos(m.estimadaCentavos as Importe),
    recorridoEstimado: { metros: m.estimadaMetros as number, segundos: m.estimadaSegundos as number },
    finalCentavos: m.finalCentavos === null ? null : aCentavos(m.finalCentavos),
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
    zonaId: m.zonaId,
    flotaId: m.flotaId,
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
    zonaId: f.zone_id,
    flotaId: f.fleet_id,
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
    montoCentavos: aCentavos(m.montoCentavos),
    moneda: 'ARS',
    estado: m.estado as EstadoCobro,
    intentosFallidos: m.intentosFallidos,
    referencia: m.referencia,
    motivoRechazo: m.motivoRechazo,
  });
}

/**
 * La zona que cubre el punto (ST_Covers: incluye el borde). Las zonas no se superponen; en un borde
 * compartido quedan dos y gana la de menor id. Usa el índice GIST de `zones.area`.
 */
export async function zonaDelPunto(db: Prisma.TransactionClient | PrismaClient, { lat, lng }: { lat: number; lng: number }) {
  const [fila] = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM zones
    WHERE ST_Covers(area, ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326))
    ORDER BY id
    LIMIT 1`;
  return fila?.id ?? null;
}

const COLUMNAS_SOLICITUD = Prisma.sql`id, passenger_id, status, origin_lat, origin_lng, destination_lat, destination_lng,
  driver_id, cancel_reason, fare_version, estimated_fare_cents, estimated_distance_m, estimated_duration_s,
  final_fare_cents, final_distance_m, final_duration_s, fare_difference_reasons, started_at, version, created_at,
  zone_id, fleet_id`;

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
export interface OpcionesDespachoPrisma {
  /**
   * Solo para tests: corre dentro de la aceptación, con el chofer y la zona de su flota ya bloqueados
   * (FOR SHARE) y antes de confirmar. Una demora acá superpone de verdad la aceptación con desactivar
   * al chofer o quitarle la zona a la flota.
   */
  trasValidarChofer?: () => Promise<void>;
}

function transaccion(tx: Prisma.TransactionClient, opciones: OpcionesDespachoPrisma = {}): TransaccionDespacho {
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
                                   version, created_at, zone_id)
        VALUES (${s.id}::uuid, ${s.pasajeroId}::uuid, ${s.estado},
                ${s.origen.lat}::float8, ${s.origen.lng}::float8, ${s.destino.lat}::float8, ${s.destino.lng}::float8,
                ${t?.version ?? null}, ${t?.estimadaCentavos ?? null}::bigint,
                ${t?.recorridoEstimado.metros ?? null}::int, ${t?.recorridoEstimado.segundos ?? null}::int,
                ${s.version}, ${s.creadaEn}::timestamptz, ${s.zonaId}::uuid)
        ON CONFLICT DO NOTHING
        RETURNING id`;
      return filas.length === 1;
    },

    async guardarSolicitud(s) {
      // La estimación no cambia nunca después de crear la solicitud: solo se escriben la final y el inicio.
      const { tarifa, iniciadoEn, zonaId, flotaId } = s.aRegistro();
      await tx.solicitudViaje.update({
        where: { id: s.id },
        data: {
          estado: s.estado,
          zonaId: zonaId ?? null,
          flotaId: flotaId ?? null,
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

    async choferAptoParaAceptar(choferId, zonaId) {
      // 1. El chofer, con FOR SHARE: desactivar y deshabilitar toman FOR UPDATE de esta fila, así que
      //    esperan a que esta transacción termine. Si uno de ellos llegó antes, esta espera y Postgres
      //    vuelve a evaluar el WHERE con la fila nueva (READ COMMITTED): ya no es apto → 0 filas.
      const [chofer] = await tx.$queryRaw<{ fleet_id: string }[]>`
        SELECT fleet_id FROM drivers
        WHERE id = ${choferId}::uuid AND approved AND active AND available
        FOR SHARE`;
      if (!chofer) return null;
      // 2. La habilitación de la zona en su flota, también con FOR SHARE: quitarle la zona a la flota
      //    (DELETE de esta fila) espera, o, si llegó antes, esta no la encuentra.
      const [zona] = await tx.$queryRaw<{ fleet_id: string }[]>`
        SELECT fleet_id FROM fleet_zones
        WHERE fleet_id = ${chofer.fleet_id}::uuid AND zone_id = ${zonaId}::uuid
        FOR SHARE`;
      if (!zona) return null;
      await opciones.trasValidarChofer?.();
      return { flotaId: chofer.fleet_id };
    },

    async zonaDelOrigen(origen) {
      return zonaDelPunto(tx, origen);
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

interface FilaReporte {
  viajes: number;
  aprobados: number;
  aprobados_centavos: string;
  pendientes: number;
  pendientes_centavos: string;
  rechazados: number;
  rechazados_centavos: string;
}

export class RepositorioDespachoPrisma implements RepositorioDespacho {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly opciones: OpcionesDespachoPrisma = {},
  ) {}

  async enTransaccion<T>(trabajo: (tx: TransaccionDespacho) => Promise<T>): Promise<T> {
    // Si el pedido HTTP trae Idempotency-Key, el registro va en esta misma transacción.
    const idempotencia = idempotenciaPendiente();
    const resultado = await this.prisma.$transaction(
      async (tx) => {
        const r = await trabajo(transaccion(tx, this.opciones));
        if (idempotencia) await registrarIdempotenciaEnTransaccion(tx, idempotencia, r);
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
    // Por el último intento, no por la creación: cada fallo actualiza updated_at y manda el cobro al
    // final de la cola. Si no, los mismos `limite` cobros que fallan se elegirían en cada barrido y los
    // más nuevos no se intentarían nunca.
    const filas = await this.prisma.cobro.findMany({
      where: { estado: 'PENDIENTE' },
      orderBy: [{ actualizadoEn: 'asc' }, { id: 'asc' }],
      select: { solicitudId: true },
      take: limite,
    });
    return filas.map((f) => f.solicitudId);
  }

  async viajeConChoferDelPasajero(pasajeroId: string) {
    // Usa el índice único parcial de solicitudes activas por pasajero: hay como mucho una.
    const filas = await this.prisma.$queryRaw<{ id: string; driver_id: string }[]>`
      SELECT id, driver_id
      FROM ride_requests
      WHERE passenger_id = ${pasajeroId}::uuid
        AND status IN (${Prisma.join(ESTADOS_CON_CHOFER)})
        AND driver_id IS NOT NULL
      LIMIT 1`;
    const f = filas[0];
    return f ? { solicitudId: f.id, choferId: f.driver_id } : null;
  }

  async viajeConPasajeroDelChofer(choferId: string) {
    // Por la asignación activa (una fila por chofer, por su clave primaria), y con el estado de la
    // solicitud: la asignación de un viaje terminado no cuenta.
    const filas = await this.prisma.$queryRaw<{ id: string; passenger_id: string }[]>`
      SELECT r.id, r.passenger_id
      FROM driver_active_assignment a
      JOIN ride_requests r ON r.id = a.request_id
      WHERE a.driver_id = ${choferId}::uuid
        AND r.status IN (${Prisma.join(ESTADOS_CON_CHOFER)})
        AND r.driver_id = a.driver_id`;
    const f = filas[0];
    return f ? { solicitudId: f.id, pasajeroId: f.passenger_id } : null;
  }

  async ofertasPendientesDelChofer(choferId: string, ahora: Date) {
    // Las pendientes son pocas (viven OFERTA_TTL_SEGUNDOS): el índice (status, expires_at) alcanza.
    // El tope solo acota la respuesta; un chofer nunca tiene tantas a la vez.
    const filas = await this.prisma.oferta.findMany({
      where: { choferId, estado: 'PENDIENTE', venceEn: { gt: ahora }, solicitud: { estado: 'BUSCANDO' } },
      include: { solicitud: true },
      orderBy: [{ venceEn: 'asc' }, { id: 'asc' }],
      take: 20,
    });
    return filas.map((f) => ({ oferta: aOferta(f), solicitud: aSolicitud(f.solicitud) }));
  }

  async reporteFlota(flotaId: string, { inicio, fin }: PeriodoReporte): Promise<DatosReporteFlota> {
    // Una sola lectura, por el índice (fleet_id, status, started_at). LEFT JOIN: un viaje completado
    // sin cobro (sin tarifa) cuenta como viaje y no suma en ningún estado. Los totales son
    // `SUM(bigint)`, que en Postgres es `numeric`: se leen como texto y se convierten sin redondear.
    const [f] = await this.prisma.$queryRaw<FilaReporte[]>`
      SELECT
        COUNT(*)::int AS viajes,
        COUNT(p.id) FILTER (WHERE p.status = 'APROBADO')::int AS aprobados,
        COALESCE(SUM(p.amount_cents) FILTER (WHERE p.status = 'APROBADO'), 0)::text AS aprobados_centavos,
        COUNT(p.id) FILTER (WHERE p.status = 'PENDIENTE')::int AS pendientes,
        COALESCE(SUM(p.amount_cents) FILTER (WHERE p.status = 'PENDIENTE'), 0)::text AS pendientes_centavos,
        COUNT(p.id) FILTER (WHERE p.status = 'RECHAZADO')::int AS rechazados,
        COALESCE(SUM(p.amount_cents) FILTER (WHERE p.status = 'RECHAZADO'), 0)::text AS rechazados_centavos
      FROM ride_requests r
      LEFT JOIN payments p ON p.request_id = r.id
      WHERE r.fleet_id = ${flotaId}::uuid
        AND r.status = 'COMPLETADA'
        AND r.started_at >= ${inicio}
        AND r.started_at < ${fin}`;
    if (!f) throw new Error('reporte de flota: la consulta no devolvió la fila de totales');
    return {
      viajesCompletados: f.viajes,
      cobros: {
        aprobados: { cantidad: f.aprobados, centavos: totalCentavos(f.aprobados_centavos) },
        pendientes: { cantidad: f.pendientes, centavos: totalCentavos(f.pendientes_centavos) },
        rechazados: { cantidad: f.rechazados, centavos: totalCentavos(f.rechazados_centavos) },
      },
    };
  }

  async tramosDeViaje(choferes: readonly string[], desde: Date, hasta: Date) {
    // Por el índice de driver_id. En un viaje activo el tramo queda abierto; en uno terminado, cierra con
    // updated_at, que solo cambia en cada transición (en un estado final no hay más).
    const filas = await this.prisma.$queryRaw<{ chofer: string; inicio: Date; fin: Date | null }[]>`
      SELECT r.driver_id AS chofer,
             COALESCE(o.created_at, r.created_at) AS inicio,
             CASE WHEN r.status IN (${Prisma.join(ESTADOS_CON_CHOFER)}) THEN NULL ELSE r.updated_at END AS fin
      FROM ride_requests r
      LEFT JOIN offers o ON o.request_id = r.id AND o.driver_id = r.driver_id AND o.status = 'ACEPTADA'
      WHERE r.driver_id = ANY(${[...choferes]}::uuid[])
        AND COALESCE(o.created_at, r.created_at) <= ${hasta}
        AND (r.status IN (${Prisma.join(ESTADOS_CON_CHOFER)}) OR r.updated_at >= ${desde})
      ORDER BY r.driver_id, inicio`;
    return filas.map((f) => ({ choferId: f.chofer, inicio: f.inicio, fin: f.fin }));
  }

  async registrarFalloCobro(cobroId: string, motivo: string) {
    // Solo si sigue pendiente: un fallo que llega tarde no toca un cobro ya resuelto.
    await this.prisma.cobro.updateMany({
      where: { id: cobroId, estado: 'PENDIENTE' },
      data: { intentosFallidos: { increment: 1 }, ultimoError: motivo.slice(0, 500), actualizadoEn: new Date() },
    });
  }
}
