import type { Logger } from '@viajes/platform';

/**
 * Barrido periódico de ofertas vencidas.
 * TODO(Fase 1): job diferido de BullMQ por oferta para reaccionar al instante; este barrido queda de respaldo.
 */
export function iniciarBarrido(vencer: () => Promise<number>, intervaloMs: number, logger: Logger): () => Promise<void> {
  let enCurso: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    // Nunca dos barridos superpuestos en el mismo proceso.
    enCurso = enCurso.then(async () => {
      try {
        const n = await vencer();
        if (n > 0) logger.info({ solicitudes: n }, 'barrido: ofertas vencidas procesadas');
      } catch (err) {
        logger.error({ err }, 'barrido: falló');
      }
    });
  }, intervaloMs);
  timer.unref();

  return async () => {
    clearInterval(timer);
    await enCurso;
  };
}
