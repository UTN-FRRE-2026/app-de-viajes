import express, { type Express, type Router } from 'express';
import { middlewareRequestId } from './contexto.js';
import { middlewareErrores, middlewareNoEncontrado } from './errores.js';
import type { Logger } from './logger.js';
import { middlewareDuracion, rutaMetricas, type Metricas } from './metricas.js';
import { rutasSalud, type ChequeoListo } from './salud.js';
import { middlewareSeguridad } from './seguridad.js';

interface OpcionesApp {
  logger: Logger;
  rutas: Router;
  chequeos: ChequeoListo[];
  limiteBody?: string;
  /** Con métricas: mide cada pedido y publica `GET /metrics`, protegido con el token. */
  metricas?: { metricas: Metricas; token: string };
}

/** Arma la app con el mismo orden de middlewares en todos los servicios. */
export function crearApp({ logger, rutas, chequeos, limiteBody = '16kb', metricas }: OpcionesApp): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(middlewareRequestId());
  if (metricas) app.use(middlewareDuracion(metricas.metricas));
  app.use(middlewareSeguridad());
  app.use(express.json({ limit: limiteBody }));
  app.use(rutasSalud(chequeos));
  // Antes que las rutas del servicio: algunas autentican con JWT a todo lo que pasa por su router.
  if (metricas) app.use(rutaMetricas(metricas.metricas, metricas.token));
  app.use(rutas);
  app.use(middlewareNoEncontrado());
  app.use(middlewareErrores(logger));
  return app;
}
