import { Router } from 'express';

/** Un chequeo de dependencia: resuelve si está bien, lanza si no. */
export type ChequeoListo = { nombre: string; chequear: () => Promise<void> };

/**
 * /health: el proceso está vivo (no toca dependencias).
 * /ready: puede atender tráfico (BD accesible, migraciones al día, etc.).
 */
export function rutasSalud(chequeos: ChequeoListo[]): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({ estado: 'ok' });
  });
  router.get('/ready', async (_req, res) => {
    const resultados: Record<string, string> = {};
    let listo = true;
    for (const c of chequeos) {
      try {
        await c.chequear();
        resultados[c.nombre] = 'ok';
      } catch (err) {
        listo = false;
        resultados[c.nombre] = err instanceof Error ? err.message : 'error';
      }
    }
    res.status(listo ? 200 : 503).json({ estado: listo ? 'listo' : 'no_listo', chequeos: resultados });
  });
  return router;
}
