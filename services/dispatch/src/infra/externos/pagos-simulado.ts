import { randomUUID } from 'node:crypto';
import type { PedidoDeCobro, ProcesadorPagos, ResultadoCobro } from '../../dominio/puertos/index.js';

export interface OpcionesPagosSimulado {
  /** Demora artificial, para demostrar el timeout. */
  latenciaMs: number;
  /** Rechaza los cobros de más de este importe (para probar el rechazo). null: aprueba todo. */
  rechazarDesdeCentavos: number | null;
}

/**
 * Proveedor de pagos simulado. Se comporta como uno real con clave de idempotencia (por ejemplo,
 * el `X-Idempotency-Key` de Mercado Pago): la misma clave devuelve el resultado de la primera vez y
 * no cobra de nuevo, aunque lleguen dos pedidos a la vez.
 *
 * Diferencia con uno real: recuerda las claves en memoria, así que un reinicio las olvida. Un
 * proveedor real las guarda en su lado; para la simulación alcanza.
 */
export class PagosSimulado implements ProcesadorPagos {
  private readonly porClave = new Map<string, Promise<ResultadoCobro>>();
  /** Cuántos cobros hizo de verdad (uno por clave). */
  cobrosRealizados = 0;

  constructor(private readonly o: OpcionesPagosSimulado) {}

  cobrar(pedido: PedidoDeCobro): Promise<ResultadoCobro> {
    const previo = this.porClave.get(pedido.clave);
    if (previo) return previo;
    // Se guarda la promesa antes de esperar: un segundo pedido simultáneo recibe la misma.
    const resultado = this.procesar(pedido);
    this.porClave.set(pedido.clave, resultado);
    // Si falla, la clave queda libre para reintentar.
    resultado.catch(() => this.porClave.delete(pedido.clave));
    return resultado;
  }

  private async procesar({ montoCentavos }: PedidoDeCobro): Promise<ResultadoCobro> {
    if (this.o.latenciaMs > 0) await new Promise((r) => setTimeout(r, this.o.latenciaMs));
    this.cobrosRealizados++;
    const referencia = `sim-${randomUUID()}`;
    if (this.o.rechazarDesdeCentavos !== null && montoCentavos > this.o.rechazarDesdeCentavos) {
      return { aprobado: false, referencia, motivo: 'fondos insuficientes (simulado)' };
    }
    return { aprobado: true, referencia, motivo: null };
  }
}
