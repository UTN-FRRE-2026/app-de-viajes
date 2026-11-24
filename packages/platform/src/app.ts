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
  /**
   * Límite del cuerpo solo para `/interno/*` (de servicio a servicio, con token y fuera de nginx). Sin
   * esto, el mismo que `limiteBody`. Lo usa dispatch: una consulta de tramos con 1000 choferes pasa
   * los 16 KB de las rutas públicas.
   */
  limiteBodyInterno?: string;
  /** Con métricas: mide cada pedido y publica `GET /metrics`, protegido con el token. */
  metricas?: { metricas: Metricas; token: string };
  /**
   * Los proxies cuyo `X-Forwarded-For` se cree (`CONFIAR_EN_PROXY`, ver `proxyConfiable`). Sin esto,
   * `req.ip` es la dirección de la conexión y el encabezado se ignora.
   */
  confiarEnProxy?: string[];
}

/** Arma la app con el mismo orden de middlewares en todos los servicios. */
export function crearApp({ logger, rutas, chequeos, limiteBody = '16kb', limiteBodyInterno, metricas, confiarEnProxy }: OpcionesApp): Express {
  const app = express();
  app.disable('x-powered-by');
  // Solo las direcciones dadas: Express toma la IP del cliente de la última entrada de X-Forwarded-For
  // que no sea un proxy de confianza.
  app.set('trust proxy', confiarEnProxy && confiarEnProxy.length > 0 ? confiarEnProxy : false);
  app.use(middlewareRequestId());
  if (metricas) app.use(middlewareDuracion(metricas.metricas));
  app.use(middlewareSeguridad());
  const json = express.json({ limit: limiteBody });
  const jsonInterno = limiteBodyInterno ? express.json({ limit: limiteBodyInterno }) : json;
  app.use((req, res, next) => (req.path.startsWith('/interno/') ? jsonInterno : json)(req, res, next));
  app.use(rutasSalud(chequeos));
  // Antes que las rutas del servicio: algunas autentican con JWT a todo lo que pasa por su router.
  if (metricas) app.use(rutaMetricas(metricas.metricas, metricas.token));
  app.use(rutas);
  app.use(middlewareNoEncontrado());
  app.use(middlewareErrores(logger));
  return app;
}
