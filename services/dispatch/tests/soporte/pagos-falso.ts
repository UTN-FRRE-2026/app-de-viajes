import { randomUUID } from 'node:crypto';
import type { PedidoDeCobro, ProcesadorPagos, ResultadoCobro } from '../../src/dominio/puertos/index.js';

/** Qué hace el proveedor falso en los próximos cobros. */
export type ModoPagos = 'aprueba' | 'rechaza' | 'falla' | 'colgado' | { demoraMs: number };

/**
 * Proveedor de pagos para los tests. Como uno real, es idempotente por clave: con la misma clave
 * devuelve el resultado de la primera vez. Cuenta las llamadas y los cobros hechos de verdad, que es
 * lo que los tests comparan: varias llamadas con la misma clave son un solo cobro.
 */
export class PagosFalso implements ProcesadorPagos {
  modo: ModoPagos = 'aprueba';
  readonly llamadas: PedidoDeCobro[] = [];
  /** clave → resultado del cobro que se hizo de verdad. */
  readonly cobrados = new Map<string, ResultadoCobro>();
  /** Pasajeros cuyos cobros fallan siempre, sea cual sea el modo (como una tarjeta que el proveedor no procesa). */
  readonly fallanPasajeros = new Set<string>();
  private readonly enCurso = new Map<string, Promise<ResultadoCobro>>();

  async cobrar(pedido: PedidoDeCobro): Promise<ResultadoCobro> {
    this.llamadas.push(pedido);
    const hecho = this.cobrados.get(pedido.clave);
    if (hecho) return hecho;
    const previo = this.enCurso.get(pedido.clave);
    if (previo) return previo;

    const modo = this.modo;
    if (modo === 'falla' || this.fallanPasajeros.has(pedido.pasajeroId)) throw new Error('pagos caído');
    if (modo === 'colgado') return new Promise<ResultadoCobro>(() => {});

    const resultado = (async (): Promise<ResultadoCobro> => {
      if (typeof modo === 'object') await new Promise((r) => setTimeout(r, modo.demoraMs));
      const r: ResultadoCobro =
        modo === 'rechaza'
          ? { aprobado: false, referencia: `falso-${randomUUID()}`, motivo: 'tarjeta rechazada' }
          : { aprobado: true, referencia: `falso-${randomUUID()}`, motivo: null };
      this.cobrados.set(pedido.clave, r);
      return r;
    })();
    this.enCurso.set(pedido.clave, resultado);
    return resultado.finally(() => this.enCurso.delete(pedido.clave));
  }
}
