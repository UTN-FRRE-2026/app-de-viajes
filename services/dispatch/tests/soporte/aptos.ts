import { createHash } from 'node:crypto';
import { BuscadorCandidatosFijo } from '../../src/infra/externos/buscador-fijo.js';
import { Prisma, type PrismaClient } from '../../src/infra/db/generated/client.js';

/**
 * Los tests de viajes (que no son de flotas ni de zonas) usan choferes sueltos. Con el filtro de flotas
 * y zonas, esos choferes tienen que existir como aptos: una flota de test con una zona que cubre todo
 * el mapa, y cada chofer habilitado, activo y disponible en ella. El filtro y la revalidación al
 * aceptar corren igual, en SQL, contra estas filas.
 */
export const FLOTA_TEST = '00000000-0000-4000-8000-00000000f7e5';
export const ZONA_TEST = '00000000-0000-4000-8000-0000000020e5';

/** Una patente válida y estable por chofer (AB123CD), para no chocar con la restricción única. */
function patenteDe(id: string): string {
  const h = createHash('sha256').update(id).digest();
  const letra = (i: number) => String.fromCharCode(65 + (h[i]! % 26));
  const digitos = String(h.readUInt32BE(8) % 1000).padStart(3, '0');
  return `${letra(0)}${letra(1)}${digitos}${letra(2)}${letra(3)}`;
}

/** La flota y la zona de test (todo el mapa). Idempotente. */
export async function prepararZonaDeTest(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO fleets (id, name, max_active) VALUES (${FLOTA_TEST}::uuid, 'Flota de test', 10000)
    ON CONFLICT (id) DO NOTHING`;
  await prisma.$executeRaw`
    INSERT INTO zones (id, name, area)
    VALUES (${ZONA_TEST}::uuid, 'Zona de test',
            ST_GeomFromText('POLYGON((-180 -90, 180 -90, 180 90, -180 90, -180 -90))', 4326))
    ON CONFLICT (id) DO NOTHING`;
  await prisma.$executeRaw`
    INSERT INTO fleet_zones (fleet_id, zone_id) VALUES (${FLOTA_TEST}::uuid, ${ZONA_TEST}::uuid)
    ON CONFLICT DO NOTHING`;
}

/** Da de alta a estos choferes como aptos en la flota de test. Un chofer que ya existe no se toca. */
export async function registrarAptos(prisma: PrismaClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await prepararZonaDeTest(prisma);
  const filas = ids.map(
    (id) => Prisma.sql`(${id}::uuid, ${FLOTA_TEST}::uuid, ${patenteDe(id)}, 'Test', 'Test', true, true, true)`,
  );
  await prisma.$executeRaw`
    INSERT INTO drivers (id, fleet_id, vehicle_plate, vehicle_make, vehicle_model, approved, active, available)
    VALUES ${Prisma.join(filas)}
    ON CONFLICT DO NOTHING`;
}

/**
 * El buscador fijo de los tests de viajes: antes de devolver su lista, la da de alta como apta (así
 * `d.buscador.choferes = [...]` sigue alcanzando). Con `aptosAutomaticos = false` es el fijo de siempre:
 * lo usan los tests de flotas y zonas, que arman sus propias flotas.
 */
export class BuscadorDeTest extends BuscadorCandidatosFijo {
  aptosAutomaticos = true;

  constructor(private readonly prisma: PrismaClient) {
    super([]);
  }

  override async buscar(origen: unknown, opciones: { limite: number }) {
    if (this.aptosAutomaticos) await registrarAptos(this.prisma, this.choferes);
    return super.buscar(origen, opciones);
  }
}
