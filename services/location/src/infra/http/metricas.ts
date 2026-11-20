import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import type { EstadoHistorial } from '../redis/historial.js';

const RESOLUCION_MS = 10;

/**
 * monitorEventLoopDelay registra cuánto tardó en dispararse su timer, que se programa cada
 * RESOLUCION_MS: con el proceso en reposo da ~10 ms en Linux, no 0. El lag real es lo que excede la
 * resolución, y eso es lo que se publica (comprobado: un bloqueo de 200 ms da un máximo de ~210 ms
 * crudo, ~200 ms ajustado).
 */
const lagMs = (ns: number) => (Number.isFinite(ns) ? Math.max(0, ns / 1e6 - RESOLUCION_MS) : 0);

/**
 * /metrics en formato de texto de Prometheus, sin dependencias. El lag del event loop se mide desde
 * que arranca el proceso (para cada medición se reinicia el contenedor). Más adelante se pasa a
 * `platform` con prom-client para Grafana.
 */
export function rutaMetricas(estrategia: string, historial?: () => Promise<EstadoHistorial>): RequestHandler {
  const lag = monitorEventLoopDelay({ resolution: RESOLUCION_MS });
  lag.enable();

  return async (_req, res) => {
    const mem = process.memoryUsage();
    const lineas = [
      `# HELP location_event_loop_lag_ms Lag del event loop desde el arranque (monitorEventLoopDelay, sin los ${RESOLUCION_MS} ms de resolución).`,
      '# TYPE location_event_loop_lag_ms summary',
      `location_event_loop_lag_ms{quantile="0.5"} ${lagMs(lag.percentile(50)).toFixed(3)}`,
      `location_event_loop_lag_ms{quantile="0.99"} ${lagMs(lag.percentile(99)).toFixed(3)}`,
      `location_event_loop_lag_max_ms ${lagMs(lag.max).toFixed(3)}`,
      `location_event_loop_lag_mean_ms ${lagMs(lag.mean).toFixed(3)}`,
      `process_resident_memory_bytes ${mem.rss}`,
      `nodejs_heap_used_bytes ${mem.heapUsed}`,
      `location_estrategia{estrategia="${estrategia}"} 1`,
    ];
    if (historial) {
      const h = await historial();
      lineas.push(
        `location_historial_en_cola ${h.enCola}`,
        `location_historial_pendientes ${h.pendientes}`,
        `location_historial_descartados_total ${h.descartados}`,
        `location_historial_ocupacion ${h.ocupacion.toFixed(6)}`,
        `location_historial_max_cola ${h.maxCola}`,
      );
    }
    res.set('Cache-Control', 'no-store').type('text/plain; version=0.0.4').send(lineas.join('\n') + '\n');
  };
}
