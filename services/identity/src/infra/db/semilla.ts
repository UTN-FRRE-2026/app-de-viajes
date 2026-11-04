import type { Rol } from '../../dominio/entidades/index.js';
import type { HasherContrasenas } from '../../dominio/puertos/index.js';
import type { PrismaClient } from './generated/client.js';

export const FLOTA_DEMO_ID = '00000000-0000-4000-8000-0000000000f1';

/** UUID fijos: el seed es reproducible y el chofer se puede usar en DISPATCH_CANDIDATOS_DEMO. */
export const USUARIOS_SEMILLA: ReadonlyArray<{
  id: string;
  email: string;
  nombre: string;
  rol: Rol;
  fleetId: string | null;
}> = [
  { id: '00000000-0000-4000-8000-000000000001', email: 'pasajero@viajes.test', nombre: 'Pasajero Demo', rol: 'pasajero', fleetId: null },
  { id: '00000000-0000-4000-8000-000000000002', email: 'chofer@viajes.test', nombre: 'Chofer Demo', rol: 'chofer', fleetId: null },
  { id: '00000000-0000-4000-8000-000000000003', email: 'operador@viajes.test', nombre: 'Operador Demo', rol: 'operador', fleetId: null },
  { id: '00000000-0000-4000-8000-000000000004', email: 'admin@viajes.test', nombre: 'Admin Demo', rol: 'admin', fleetId: null },
  { id: '00000000-0000-4000-8000-000000000005', email: 'admin.flota@viajes.test', nombre: 'Admin Flota Demo', rol: 'admin_flota', fleetId: FLOTA_DEMO_ID },
];

/**
 * Único camino para crear roles privilegiados en este incremento, y solo en desarrollo.
 * Idempotente: se puede correr las veces que haga falta y deja siempre el mismo estado.
 */
export async function sembrarUsuarios(prisma: PrismaClient, hasher: HasherContrasenas, contrasena: string): Promise<number> {
  const hashContrasena = await hasher.hashear(contrasena);
  for (const usuario of USUARIOS_SEMILLA) {
    const datos = { ...usuario, hashContrasena };
    await prisma.usuario.upsert({ where: { email: usuario.email }, create: datos, update: datos });
  }
  return USUARIOS_SEMILLA.length;
}
