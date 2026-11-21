import type { Logger } from '@viajes/platform';

/**
 * Tarea periódica: el barrido de ofertas vencidas y el de cobros pendientes.
 * `tarea` devuelve cuántas cosas procesó; si es más de cero, se loguea con `que`.
 * TODO(Fase 1): job diferido de BullMQ por oferta para reaccionar al instante; este barrido queda de respaldo.
 */
export function iniciarBarrido(
  tarea: () => Promise<number>,
  intervaloMs: number,
  logger: Logger,
  que = 'ofertas vencidas procesadas',
): () => Promise<void> {
  let enCurso: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    // Nunca dos barridos superpuestos en el mismo proceso.
    enCurso = enCurso.then(async () => {
      try {
        const n = await tarea();
        if (n > 0) logger.info({ cantidad: n }, `barrido: ${que}`);
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
