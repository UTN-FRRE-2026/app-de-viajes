import type { Logger } from './logger.js';

/**
 * Tarea periódica del servidor: en dispatch, el barrido de ofertas vencidas, el de cobros pendientes
 * y el relay de eventos; en los dos servicios con Idempotency-Key, la purga de las claves vencidas.
 * `tarea` devuelve cuántas cosas procesó; si es más de cero, se loguea con `que`.
 * Devuelve cómo detenerla: espera a que termine la pasada en curso (para el apagado ordenado).
 */
export function iniciarBarrido(
  tarea: () => Promise<number>,
  intervaloMs: number,
  logger: Logger,
  que: string,
  nivel: 'info' | 'debug' = 'info',
): () => Promise<void> {
  let enCurso: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    // Nunca dos pasadas superpuestas en el mismo proceso.
    enCurso = enCurso.then(async () => {
      try {
        const n = await tarea();
        if (n > 0) logger[nivel]({ cantidad: n }, `barrido: ${que}`);
      } catch (err) {
        logger.error({ err }, `barrido (${que}): falló`);
      }
    });
  }, intervaloMs);
  timer.unref();

  return async () => {
    clearInterval(timer);
    await enCurso;
  };
}
