import type { RequestHandler } from 'express';
import helmet from 'helmet';

/**
 * Política CSP de las APIs. Los servicios solo devuelven JSON, así que no
 * necesitan cargar nada: se niega todo. Si una respuesta se llegara a abrir en
 * el navegador (por ejemplo, un error que refleja un dato del usuario), no
 * puede ejecutar scripts, cargar recursos, enviar formularios ni quedar
 * embebida en un iframe de otro sitio.
 *
 * La CSP de la página (el frontend) va en nginx, que es quien sirve el HTML.
 */
export const CSP_API = {
  defaultSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'none'"],
} as const;

/** Encabezados de seguridad comunes (CSP, nosniff, HSTS, frameguard, etc.). */
export function middlewareSeguridad(): RequestHandler {
  return helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { ...CSP_API } },
  });
}
