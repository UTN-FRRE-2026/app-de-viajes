import { ErrorHttp, type Logger } from '@viajes/platform';
import type { Coordenada } from '../../dominio/entidades/index.js';
import type { Recorrido } from '../../dominio/tarifas/calculo.js';
import type { ServicioMapas } from '../../dominio/puertos/index.js';

const esEnteroNoNegativo = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * Envuelve cualquier adaptador de mapas (el simulado hoy, uno real mañana) y **falla cerrado**:
 * si no contesta dentro del timeout, falla, o devuelve algo que no son enteros no negativos,
 * responde 503 `MAPAS_NO_DISPONIBLE`. Nunca se estima con un recorrido inventado.
 *
 * El timeout corta la espera, no el pedido de adentro: un adaptador real tiene que cancelar el suyo
 * (por ejemplo, con un AbortSignal).
 */
export class MapasConTimeout implements ServicioMapas {
  constructor(
    private readonly interno: ServicioMapas,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
  ) {}

  async recorrido(origen: Coordenada, destino: Coordenada): Promise<Recorrido> {
    let timer: NodeJS.Timeout | undefined;
    const vencido = new Promise<never>((_, rechazar) => {
      timer = setTimeout(() => rechazar(new Error(`sin respuesta en ${this.timeoutMs} ms`)), this.timeoutMs);
    });
    try {
      const r = await Promise.race([this.interno.recorrido(origen, destino), vencido]);
      if (!esEnteroNoNegativo(r?.metros) || !esEnteroNoNegativo(r?.segundos)) {
        throw new Error('respuesta fuera de contrato');
      }
      return { metros: r.metros, segundos: r.segundos };
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'mapas: sin recorrido');
      throw new ErrorHttp(503, 'MAPAS_NO_DISPONIBLE', 'No se puede estimar la tarifa en este momento');
    } finally {
      clearTimeout(timer);
    }
  }
}
