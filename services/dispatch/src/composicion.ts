import { fileURLToPath } from 'node:url';
import type { Reloj } from '@viajes/kernel';
import { crearApp, verificadorJwks, type ChequeoListo, type Logger, type VerificadorToken } from '@viajes/platform';
import type { Express } from 'express';
import { crearCasosDeUso, type CasosDeUso } from './dominio/casos-uso/index.js';
import type { BuscadorCandidatos, RepositorioDespacho } from './dominio/puertos/index.js';
import type { Config } from './config/index.js';
import { crearPrisma } from './infra/db/cliente.js';
import { RepositorioDespachoPrisma } from './infra/db/repositorio-prisma.js';
import { chequeosBase } from './infra/db/salud.js';
import { BuscadorCandidatosFijo } from './infra/externos/buscador-fijo.js';
import { idsAleatorios, relojSistema } from './infra/externos/sistema.js';
import { rutasDespacho } from './infra/http/rutas.js';
import { RepositorioDespachoMemoria } from './infra/memoria/repositorio-memoria.js';

/** Reemplazos para tests: cualquier adaptador se puede inyectar desde afuera. */
export interface Reemplazos {
  verificador?: VerificadorToken;
  buscador?: BuscadorCandidatos;
  reloj?: Reloj;
  repo?: RepositorioDespacho;
}

export interface Sistema {
  app: Express;
  casos: CasosDeUso;
  repo: RepositorioDespacho;
  cerrar: () => Promise<void>;
}

const carpetaMigraciones = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

/** Único lugar que conoce los adaptadores concretos. */
export function componer(config: Config, logger: Logger, reemplazos: Reemplazos = {}): Sistema {
  let repo: RepositorioDespacho;
  let chequeos: ChequeoListo[] = [];
  let cerrar = async () => {};

  if (reemplazos.repo) {
    repo = reemplazos.repo;
  } else if (config.DISPATCH_PERSISTENCIA === 'memoria') {
    repo = new RepositorioDespachoMemoria();
  } else {
    const prisma = crearPrisma(config.DATABASE_URL as string, config.DB_POOL_MAX);
    repo = new RepositorioDespachoPrisma(prisma);
    chequeos = chequeosBase(prisma, carpetaMigraciones);
    cerrar = () => prisma.$disconnect();
  }

  const casos = crearCasosDeUso({
    repo,
    buscador: reemplazos.buscador ?? new BuscadorCandidatosFijo(config.DISPATCH_CANDIDATOS_DEMO),
    reloj: reemplazos.reloj ?? relojSistema,
    ids: idsAleatorios,
    parametros: {
      ofertasSimultaneas: config.OFERTAS_SIMULTANEAS,
      ttlOfertaMs: config.OFERTA_TTL_SEGUNDOS * 1000,
    },
  });

  const verificador =
    reemplazos.verificador ??
    verificadorJwks(config.JWKS_URL, { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE });

  const app = crearApp({ logger, rutas: rutasDespacho(casos, verificador), chequeos });
  return { app, casos, repo, cerrar };
}
