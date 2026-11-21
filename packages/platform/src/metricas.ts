import { createHash, timingSafeEqual } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Router, type Request, type RequestHandler } from 'express';
import { Gauge, Histogram, Registry } from '@prometheus-io/client';
import { z } from 'zod';
import { ErrorHttp } from './errores.js';

/** `METRICAS_TOKEN` en la configuración de cada servicio: obligatorio y largo. */
export const tokenMetricas = z.string().min(32, 'tiene que tener al menos 32 caracteres').max(256);

// Los servicios arman sus métricas propias con estas clases, sobre el mismo Registry.
export { Counter, Gauge, Histogram, type Registry } from '@prometheus-io/client';

const RESOLUCION_MS = 10;

/**
 * monitorEventLoopDelay registra cuánto tardó en dispararse su timer, que se programa cada
 * RESOLUCION_MS: con el proceso en reposo da ~10 ms en Linux, no 0. El lag real es lo que excede la
 * resolución, y eso es lo que se publica (comprobado: un bloqueo de 200 ms da un máximo de ~210 ms
 * crudo, ~200 ms ajustado).
 */
const lagMs = (ns: number) => (Number.isFinite(ns) ? Math.max(0, ns / 1e6 - RESOLUCION_MS) : 0);

/** Etiqueta de ruta de un pedido que no llegó a ninguna ruta (404, o rechazado antes por un middleware). */
export const RUTA_SIN_RUTA = 'sin_ruta';

export interface Metricas {
  readonly servicio: string;
  readonly registro: Registry;
  readonly duracionHttp: Histogram<'metodo' | 'ruta' | 'estado'>;
  /** Apaga el monitor del event loop. */
  detener(): void;
}

/**
 * Métricas comunes de un servicio, en un Registry propio (nunca el global: los tests arman varios
 * servicios en el mismo proceso). Todas las series llevan la etiqueta `servicio`.
 * - Lag del event loop desde el arranque (el proceso se reinicia antes de cada medición).
 * - Memoria: RSS y heap usado.
 * - Duración de los pedidos HTTP por método, ruta (el patrón, no la URL) y estado.
 */
export function crearMetricas({ servicio }: { servicio: string }): Metricas {
  const registro = new Registry();
  registro.setDefaultLabels({ servicio });

  const lag = monitorEventLoopDelay({ resolution: RESOLUCION_MS });
  lag.enable();

  new Gauge({
    name: 'event_loop_lag_ms',
    help: `Lag del event loop desde el arranque (monitorEventLoopDelay, sin los ${RESOLUCION_MS} ms de resolución).`,
    labelNames: ['quantile'] as const,
    registers: [registro],
    collect() {
      this.set({ quantile: '0.5' }, lagMs(lag.percentile(50)));
      this.set({ quantile: '0.99' }, lagMs(lag.percentile(99)));
    },
  });
  new Gauge({
    name: 'event_loop_lag_max_ms',
    help: 'Lag máximo del event loop desde el arranque.',
    registers: [registro],
    collect() {
      this.set(lagMs(lag.max));
    },
  });
  new Gauge({
    name: 'event_loop_lag_mean_ms',
    help: 'Lag promedio del event loop desde el arranque.',
    registers: [registro],
    collect() {
      this.set(lagMs(lag.mean));
    },
  });
  new Gauge({
    name: 'process_resident_memory_bytes',
    help: 'Memoria residente del proceso (RSS).',
    registers: [registro],
    collect() {
      this.set(process.memoryUsage().rss);
    },
  });
  new Gauge({
    name: 'nodejs_heap_used_bytes',
    help: 'Heap de V8 en uso.',
    registers: [registro],
    collect() {
      this.set(process.memoryUsage().heapUsed);
    },
  });

  const duracionHttp = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duración de los pedidos HTTP, desde que entran hasta que se termina de enviar la respuesta.',
    labelNames: ['metodo', 'ruta', 'estado'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registro],
  });

  return { servicio, registro, duracionHttp, detener: () => lag.disable() };
}

/**
 * Ruta del pedido como patrón (`/solicitudes/:id`), nunca la URL cruda: con ids en la etiqueta,
 * cada pedido crearía una serie nueva. Si ninguna ruta lo atendió, `sin_ruta`.
 */
function rutaDe(req: Request): string {
  const patron = (req.route as { path?: unknown } | undefined)?.path;
  return typeof patron === 'string' ? `${req.baseUrl}${patron}` : RUTA_SIN_RUTA;
}

/** Mide cada pedido. Se monta antes que todo lo demás, así cuenta también los rechazos tempranos. */
export function middlewareDuracion(metricas: Metricas): RequestHandler {
  return (req, res, next) => {
    const inicio = process.hrtime.bigint();
    res.once('finish', () => {
      const segundos = Number(process.hrtime.bigint() - inicio) / 1e9;
      metricas.duracionHttp.observe({ metodo: req.method, ruta: rutaDe(req), estado: String(res.statusCode) }, segundos);
    });
    next();
  };
}

const huella = (valor: string) => createHash('sha256').update(valor).digest();

/**
 * `GET /metrics` con `Authorization: Bearer <token>` (Alloy/Prometheus lo mandan con `bearer_token`).
 * - Se comparan las huellas SHA-256 en tiempo constante. Nunca se loguea ni se devuelve el valor.
 * - Sin el encabezado o con otro valor: siempre 401 con el mismo mensaje.
 * - No se publica por nginx.
 */
export function rutaMetricas(metricas: Metricas, token: string): Router {
  const esperado = huella(token);
  const r = Router();
  r.get(
    '/metrics',
    (req, _res, next) => {
      const encabezado = req.header('authorization') ?? '';
      const recibido = /^Bearer ([^\s]{1,256})$/.exec(encabezado)?.[1];
      if (!recibido || !timingSafeEqual(huella(recibido), esperado)) {
        throw new ErrorHttp(401, 'TOKEN_METRICAS_INVALIDO', 'Falta el token de métricas o no es válido');
      }
      next();
    },
    async (_req, res) => {
      const texto = await metricas.registro.metrics();
      res.set('Cache-Control', 'no-store').type(metricas.registro.contentType).send(texto);
    },
  );
  return r;
}
