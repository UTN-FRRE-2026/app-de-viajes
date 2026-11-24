import { idempotenciaPendiente, idempotenciaRegistrada, registrarIdempotenciaEnTransaccion } from '@viajes/platform';
import { ChoferFlota, type DatosFlota, type Flota } from '../../dominio/flotas/index.js';
import type { DatosZona, Pagina, RepositorioFlotas, TransaccionFlotas } from '../../dominio/puertos/index.js';
import { Prisma, type PrismaClient } from './generated/client.js';

interface FilaChofer {
  id: string;
  fleet_id: string;
  vehicle_plate: string;
  vehicle_make: string;
  vehicle_model: string;
  approved: boolean;
  active: boolean;
  available: boolean;
}

interface FilaFlota {
  id: string;
  name: string;
  max_active: number;
  active_count: number;
}

const aChofer = (f: FilaChofer) =>
  ChoferFlota.reconstruir({
    id: f.id,
    flotaId: f.fleet_id,
    vehiculo: { patente: f.vehicle_plate, marca: f.vehicle_make, modelo: f.vehicle_model },
    habilitado: f.approved,
    activo: f.active,
    disponible: f.available,
  });

const aFlota = (f: FilaFlota): Flota => ({ id: f.id, nombre: f.name, maxActivos: f.max_active, activos: f.active_count });

const COLUMNAS_CHOFER = Prisma.sql`id, fleet_id, vehicle_plate, vehicle_make, vehicle_model, approved, active, available`;

export interface OpcionesFlotasPrisma {
  /**
   * Solo para tests: corre dentro de la transacción, con el chofer ya bloqueado y antes de tocar la
   * flota. Una demora acá superpone de verdad las activaciones simultáneas.
   */
  trasBloquearChofer?: () => Promise<void>;
  /**
   * Solo para tests: corre dentro de la transacción que reemplaza las zonas de una flota, después de
   * quitar las que ya no van (con sus filas bloqueadas) y antes de confirmar.
   */
  trasQuitarZonas?: () => Promise<void>;
}

interface FilaZona {
  id: string;
  name: string;
  area: string;
}

/** GeoJSON de PostGIS → el anillo exterior como pares [lng, lat]. */
const aZona = (f: FilaZona): DatosZona => ({
  id: f.id,
  nombre: f.name,
  anillo: (JSON.parse(f.area) as { coordinates: [number, number][][] }).coordinates[0]!,
});

/** El polígono, de GeoJSON a geometry con SRID 4326 (lng/lat). */
const geometria = (anillo: [number, number][]) =>
  Prisma.sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify({ type: 'Polygon', coordinates: [anillo] })}), 4326)`;

/** Todas las escrituras de zonas se serializan con este advisory lock (por transacción). */
const LOCK_ZONAS = 'dispatch:zones';

/**
 * Las garantías de la carrera G viven en este archivo, en SQL:
 * - el FOR UPDATE del chofer: dos pedidos sobre el mismo chofer se serializan y el segundo ve que
 *   ya está activo, así no ocupa otro cupo;
 * - el UPDATE condicional de la flota (`active_count < max_active`): Postgres lo evalúa con la fila
 *   bloqueada, así N activaciones simultáneas dejan como mucho `max_active`;
 * - el CHECK `fleets_cupo_check`, por si algún día alguien saltea lo anterior.
 * Orden de locks: siempre el chofer y después la flota.
 */
function transaccion(tx: Prisma.TransactionClient, opciones: OpcionesFlotasPrisma): TransaccionFlotas {
  return {
    async obtenerChoferParaActualizar(id) {
      const [fila] = await tx.$queryRaw<FilaChofer[]>`
        SELECT ${COLUMNAS_CHOFER} FROM drivers WHERE id = ${id}::uuid FOR UPDATE`;
      if (fila) await opciones.trasBloquearChofer?.();
      return fila ? aChofer(fila) : null;
    },

    async guardarChofer(chofer) {
      const d = chofer.aDatos();
      await tx.$executeRaw`
        UPDATE drivers
        SET approved = ${d.habilitado}, active = ${d.activo}, available = ${d.disponible}, updated_at = now()
        WHERE id = ${d.id}::uuid`;
    },

    async insertarChofer(chofer) {
      const d = chofer.aDatos();
      // Sin destino en ON CONFLICT: atrapa la clave primaria (el chofer ya está en una flota) y la
      // patente única. Las dos las decide la base, aunque lleguen dos altas a la vez.
      const filas = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO drivers (id, fleet_id, vehicle_plate, vehicle_make, vehicle_model)
        VALUES (${d.id}::uuid, ${d.flotaId}::uuid, ${d.vehiculo.patente}, ${d.vehiculo.marca}, ${d.vehiculo.modelo})
        ON CONFLICT DO NOTHING
        RETURNING id`;
      if (filas.length === 1) return 'ok';
      const [existe] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM drivers WHERE id = ${d.id}::uuid`;
      return existe ? 'chofer_existe' : 'patente_existe';
    },

    async ocuparCupo(flotaId) {
      // La carrera G: comparar y sumar en una sola sentencia. Postgres bloquea la fila de la flota,
      // y quien espera vuelve a evaluar el WHERE con el valor nuevo (READ COMMITTED).
      const filas = await tx.$queryRaw<{ active_count: number }[]>`
        UPDATE fleets
        SET active_count = active_count + 1, updated_at = now()
        WHERE id = ${flotaId}::uuid AND active_count < max_active
        RETURNING active_count`;
      return filas.length === 1;
    },

    async liberarCupo(flotaId) {
      await tx.$executeRaw`
        UPDATE fleets SET active_count = active_count - 1, updated_at = now() WHERE id = ${flotaId}::uuid`;
    },

    async guardarFlota({ id, nombre, maxActivos }: DatosFlota) {
      // Crea o actualiza. Si el límite nuevo queda por debajo de los activos, el WHERE no deja
      // actualizar (0 filas) y no se cambia nada. Bloquea la fila igual que una activación.
      const filas = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO fleets (id, name, max_active)
        VALUES (${id}::uuid, ${nombre}, ${maxActivos})
        ON CONFLICT (id) DO UPDATE
          SET name = EXCLUDED.name, max_active = EXCLUDED.max_active, updated_at = now()
          WHERE fleets.active_count <= EXCLUDED.max_active
        RETURNING id`;
      return filas.length === 1 ? 'ok' : 'limite_menor';
    },

    async obtenerFlota(id) {
      const [fila] = await tx.$queryRaw<FilaFlota[]>`
        SELECT id, name, max_active, active_count FROM fleets WHERE id = ${id}::uuid`;
      return fila ? aFlota(fila) : null;
    },

    async guardarZona({ id, nombre, anillo }) {
      // Un CHECK no puede mirar otras filas: la superposición se controla acá, con las escrituras de
      // zonas en fila (advisory lock hasta el final de la transacción). Dos PUT simultáneos no pueden
      // dejar dos zonas superpuestas: el segundo ve la primera ya guardada.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_ZONAS}))`;
      const g = geometria(anillo);
      const [validez] = await tx.$queryRaw<{ valida: boolean; motivo: string }[]>`
        SELECT ST_IsValid(${g}) AS valida, ST_IsValidReason(${g}) AS motivo`;
      if (!validez?.valida) return { resultado: 'invalida', motivo: validez?.motivo ?? 'desconocido' };
      // Se superponen si comparten interior: tocarse en el borde está permitido.
      const [otra] = await tx.$queryRaw<{ name: string }[]>`
        SELECT name FROM zones
        WHERE id <> ${id}::uuid AND ST_Intersects(area, ${g}) AND NOT ST_Touches(area, ${g})
        ORDER BY id
        LIMIT 1`;
      if (otra) return { resultado: 'superpuesta', con: otra.name };
      await tx.$executeRaw`
        INSERT INTO zones (id, name, area) VALUES (${id}::uuid, ${nombre}, ${g})
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, area = EXCLUDED.area, updated_at = now()`;
      return { resultado: 'ok' };
    },

    async reemplazarZonasDeFlota(flotaId, zonas) {
      // FOR NO KEY UPDATE y no FOR UPDATE: dos reemplazos de la misma flota se serializan, pero las
      // claves foráneas hacia la flota (fleet_id de una solicitud que se acepta) no esperan.
      const [flota] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM fleets WHERE id = ${flotaId}::uuid FOR NO KEY UPDATE`;
      if (!flota) return 'flota_no_existe';
      const ids = [...new Set(zonas)];
      const [existentes] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM zones WHERE id = ANY(${ids}::uuid[])`;
      if ((existentes?.n ?? 0) !== ids.length) return 'zona_no_existe';
      // Quitar una zona choca con el FOR SHARE de una aceptación en curso que la usa: espera a que
      // termine. Una aceptación que llega después ya no encuentra la fila.
      await tx.$executeRaw`
        DELETE FROM fleet_zones WHERE fleet_id = ${flotaId}::uuid AND NOT (zone_id = ANY(${ids}::uuid[]))`;
      await opciones.trasQuitarZonas?.();
      await tx.$executeRaw`
        INSERT INTO fleet_zones (fleet_id, zone_id)
        SELECT ${flotaId}::uuid, z FROM unnest(${ids}::uuid[]) AS z
        ON CONFLICT DO NOTHING`;
      return 'ok';
    },

    async obtenerZona(id) {
      const [fila] = await tx.$queryRaw<FilaZona[]>`
        SELECT id, name, ST_AsGeoJSON(area) AS area FROM zones WHERE id = ${id}::uuid`;
      return fila ? aZona(fila) : null;
    },

    async zonasDeFlota(flotaId) {
      const filas = await tx.$queryRaw<{ zone_id: string }[]>`
        SELECT zone_id FROM fleet_zones WHERE fleet_id = ${flotaId}::uuid ORDER BY zone_id`;
      return filas.map((f) => f.zone_id);
    },
  };
}

export class RepositorioFlotasPrisma implements RepositorioFlotas {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly opciones: OpcionesFlotasPrisma = {},
  ) {}

  async enTransaccion<T>(trabajo: (tx: TransaccionFlotas) => Promise<T>): Promise<T> {
    // Igual que RepositorioDespachoPrisma: si el pedido trae Idempotency-Key, el registro confirma
    // junto con el cambio del chofer y del contador, o no confirma.
    const idempotencia = idempotenciaPendiente();
    const resultado = await this.prisma.$transaction(
      async (tx) => {
        const r = await trabajo(transaccion(tx, this.opciones));
        if (idempotencia) await registrarIdempotenciaEnTransaccion(tx, idempotencia, r);
        return r;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        // 50 activaciones simultáneas esperan el lock de la flota y una conexión libre del pool.
        maxWait: 10_000,
        timeout: 10_000,
      },
    );
    if (idempotencia) idempotenciaRegistrada();
    return resultado;
  }

  async obtenerFlota(id: string) {
    const [fila] = await this.prisma.$queryRaw<FilaFlota[]>`
      SELECT id, name, max_active, active_count FROM fleets WHERE id = ${id}::uuid`;
    return fila ? aFlota(fila) : null;
  }

  async obtenerChofer(id: string) {
    const [fila] = await this.prisma.$queryRaw<FilaChofer[]>`SELECT ${COLUMNAS_CHOFER} FROM drivers WHERE id = ${id}::uuid`;
    return fila ? aChofer(fila) : null;
  }

  async listarZonas() {
    const filas = await this.prisma.$queryRaw<FilaZona[]>`
      SELECT id, name, ST_AsGeoJSON(area) AS area FROM zones ORDER BY name, id`;
    return filas.map(aZona);
  }

  async zonasDeFlota(flotaId: string) {
    const filas = await this.prisma.$queryRaw<{ zone_id: string }[]>`
      SELECT zone_id FROM fleet_zones WHERE fleet_id = ${flotaId}::uuid ORDER BY zone_id`;
    return filas.map((f) => f.zone_id);
  }

  async listarChoferes(flotaId: string, { limite, desde }: Pagina) {
    const filas = await this.prisma.$queryRaw<FilaChofer[]>`
      SELECT ${COLUMNAS_CHOFER} FROM drivers
      WHERE fleet_id = ${flotaId}::uuid
      ORDER BY created_at, id
      LIMIT ${limite} OFFSET ${desde}`;
    return filas.map(aChofer);
  }
}
