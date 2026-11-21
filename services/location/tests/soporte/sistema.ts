import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crearLogger } from '@viajes/platform';
import { componer, type Reemplazos } from '../../src/composicion.js';
import { EsquemaConfig } from '../../src/config/index.js';
import { crearPrisma } from '../../src/infra/db/cliente.js';
import { URL_BD_TEST } from './preparar-bd.js';
import { prefijoUnico, URL_REDIS_TEST } from './redis.js';
import { crearEmisorTokens } from './tokens.js';

/** Un secreto distinto en cada corrida: los tests nunca usan ni muestran el del .env. */
export const TOKEN_SERVICIO = randomBytes(32).toString('base64url');
export const TOKEN_METRICAS = randomBytes(32).toString('base64url');

export function configTest(extra: Record<string, string> = {}) {
  return EsquemaConfig.parse({
    UBICACION_ESTRATEGIA: 'ingenua',
    LOCATION_DATABASE_URL: URL_BD_TEST,
    REDIS_URL: URL_REDIS_TEST,
    LOCATION_REDIS_PREFIJO: prefijoUnico(),
    JWKS_URL: 'http://identity.invalid/.well-known/jwks.json',
    JWT_ISSUER: 'viajes-identity-test',
    JWT_AUDIENCE: 'viajes',
    LOCATION_TOKEN_SERVICIO: TOKEN_SERVICIO,
    METRICAS_TOKEN: TOKEN_METRICAS,
    // En los tests el consumidor del historial se maneja a mano: espera corta para no frenar el cierre.
    LOCATION_HISTORIAL_ESPERA_MS: '100',
    ...extra,
  });
}

/**
 * location completo (HTTP, casos de uso y la estrategia pedida) en un puerto real.
 * Lo de segundo plano (consumidor del historial, purga) no arranca solo: los tests lo manejan.
 */
export async function levantarLocation(reemplazos: Reemplazos = {}, config: Record<string, string> = {}) {
  const tokens = await crearEmisorTokens();
  const configuracion = configTest(config);
  const sistema = componer(configuracion, crearLogger('location-test', 'silent'), {
    verificador: tokens.verificador,
    ...reemplazos,
  });
  const prisma = crearPrisma(URL_BD_TEST, 5);
  // Sin cola offline, el publicador falla hasta conectarse: los tests arrancan con él listo.
  await sistema.publicador?.listo();

  const servidor: Server = await new Promise((resolver) => {
    const s = sistema.app.listen(0, () => resolver(s));
  });
  const { port } = servidor.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    prisma,
    config: configuracion,
    casos: sistema.casos,
    historial: sistema.historial,
    ...tokens,
    servicio: { 'X-Token-Servicio': TOKEN_SERVICIO },
    conMetricas: { Authorization: `Bearer ${TOKEN_METRICAS}` },
    async limpiar() {
      await prisma.$executeRawUnsafe('TRUNCATE pings');
    },
    async cerrar() {
      await new Promise<void>((r) => servidor.close(() => r()));
      await sistema.cerrar();
      await prisma.$disconnect();
    },
  };
}

export type Location = Awaited<ReturnType<typeof levantarLocation>>;
