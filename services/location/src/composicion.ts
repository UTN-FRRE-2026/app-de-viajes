import { fileURLToPath } from 'node:url';
import type { Reloj } from '@viajes/kernel';
import { crearApp, verificadorJwks, type ChequeoListo, type Logger, type VerificadorToken } from '@viajes/platform';
import type { Express } from 'express';
import type { Config } from './config/index.js';
import { crearCasosDeUso, type CasosDeUso } from './dominio/casos-uso/index.js';
import type { RepositorioUbicaciones } from './dominio/puertos/index.js';
import { crearPrisma } from './infra/db/cliente.js';
import { RepositorioUbicacionesIngenuo } from './infra/db/repositorio-ingenuo.js';
import { chequeosBase } from './infra/db/salud.js';
import { relojSistema } from './infra/externos/sistema.js';
import { rutasUbicacion } from './infra/http/rutas.js';
import { RepositorioUbicacionesMemoria } from './infra/memoria/repositorio-memoria.js';

/** Reemplazos para tests: cualquier adaptador se puede inyectar desde afuera. */
export interface Reemplazos {
  verificador?: VerificadorToken;
  repo?: RepositorioUbicaciones;
  reloj?: Reloj;
}

export interface Sistema {
  app: Express;
  casos: CasosDeUso;
  repo: RepositorioUbicaciones;
  cerrar: () => Promise<void>;
}

const carpetaMigraciones = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

/** Único lugar que conoce los adaptadores concretos. La estrategia de 6.6 se elige acá. */
export function componer(config: Config, logger: Logger, reemplazos: Reemplazos = {}): Sistema {
  let repo: RepositorioUbicaciones;
  let chequeos: ChequeoListo[] = [];
  let cerrar = async () => {};

  if (reemplazos.repo) {
    repo = reemplazos.repo;
  } else if (config.UBICACION_ESTRATEGIA === 'memoria') {
    repo = new RepositorioUbicacionesMemoria();
  } else {
    const prisma = crearPrisma(config.LOCATION_DATABASE_URL as string, config.DB_POOL_MAX);
    repo = new RepositorioUbicacionesIngenuo(prisma);
    chequeos = chequeosBase(prisma, carpetaMigraciones);
    cerrar = () => prisma.$disconnect();
  }

  const casos = crearCasosDeUso({
    repo,
    reloj: reemplazos.reloj ?? relojSistema,
    vigenciaMs: config.UBICACION_VIGENCIA_SEGUNDOS * 1000,
  });

  const verificador =
    reemplazos.verificador ??
    verificadorJwks(config.JWKS_URL, { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE });

  const app = crearApp({
    logger,
    rutas: rutasUbicacion(casos, verificador, config.LOCATION_TOKEN_SERVICIO),
    chequeos,
  });
  return { app, casos, repo, cerrar };
}
