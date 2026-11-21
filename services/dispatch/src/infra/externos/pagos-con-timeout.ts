import { ErrorHttp, type Logger } from '@viajes/platform';
import type { PedidoDeCobro, ProcesadorPagos, ResultadoCobro } from '../../dominio/puertos/index.js';

const esRespuestaValida = (r: unknown): r is ResultadoCobro => {
  const v = r as ResultadoCobro | undefined;
  return (
    typeof v?.aprobado === 'boolean' &&
    typeof v.referencia === 'string' &&
    v.referencia.length > 0 &&
    (v.aprobado || typeof v.motivo === 'string')
  );
};

/**
 * Envuelve cualquier adaptador de pagos y **falla cerrado**, como `MapasConTimeout`: si no contesta
 * dentro del timeout, falla o devuelve algo fuera de contrato, responde 503 `PAGOS_NO_DISPONIBLE`.
 * Nunca se da un cobro por hecho sin la confirmación del proveedor: queda PENDIENTE y se reintenta
 * con la misma clave, así que si el proveedor llegó a cobrar, el reintento recibe ese mismo resultado.
 */
export class PagosConTimeout implements ProcesadorPagos {
  constructor(
    private readonly interno: ProcesadorPagos,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
  ) {}

  async cobrar(pedido: PedidoDeCobro): Promise<ResultadoCobro> {
    let timer: NodeJS.Timeout | undefined;
    const vencido = new Promise<never>((_, rechazar) => {
      timer = setTimeout(() => rechazar(new Error(`sin respuesta en ${this.timeoutMs} ms`)), this.timeoutMs);
    });
    try {
      const r = await Promise.race([this.interno.cobrar(pedido), vencido]);
      if (!esRespuestaValida(r)) throw new Error('respuesta fuera de contrato');
      return { aprobado: r.aprobado, referencia: r.referencia, motivo: r.aprobado ? null : r.motivo };
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err), cobro: pedido.clave }, 'pagos: sin respuesta');
      throw new ErrorHttp(503, 'PAGOS_NO_DISPONIBLE', 'No se pudo procesar el cobro en este momento; queda pendiente');
    } finally {
      clearTimeout(timer);
    }
  }
}
