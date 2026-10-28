import express, { type Express, type Router } from 'express';
import { middlewareRequestId } from './contexto.js';
import { middlewareErrores, middlewareNoEncontrado } from './errores.js';
import type { Logger } from './logger.js';
import { rutasSalud, type ChequeoListo } from './salud.js';

interface OpcionesApp {
  logger: Logger;
  rutas: Router;
  chequeos: ChequeoListo[];
  limiteBody?: string;
}

/** Arma la app con el mismo orden de middlewares en todos los servicios. */
export function crearApp({ logger, rutas, chequeos, limiteBody = '16kb' }: OpcionesApp): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(middlewareRequestId());
  app.use(express.json({ limit: limiteBody }));
  app.use(rutasSalud(chequeos));
  app.use(rutas);
  app.use(middlewareNoEncontrado());
  app.use(middlewareErrores(logger));
  return app;
}
