import type { Coordenada } from '../entidades/index.js';
import type { DependenciasDespacho } from './dependencias.js';

/** El primer lote que se le pide a location, aunque haga falta menos. */
export const LOTE_MINIMO = 10;
/** El tope por consulta de location (`LIMITE_CANDIDATOS_MAX`). */
export const LOTE_MAXIMO = 100;

/** Los tamaños de lote: desde `inicial` (con piso y techo), duplicando hasta el tope. 10 → 10, 20, 40, 80, 100. */
export function lotes(inicial: number): number[] {
  const r: number[] = [];
  let n = Math.min(LOTE_MAXIMO, Math.max(LOTE_MINIMO, inicial));
  for (;;) {
    r.push(n);
    if (n >= LOTE_MAXIMO) return r;
    n = Math.min(LOTE_MAXIMO, n * 2);
  }
}

export interface ResultadoBusqueda {
  /** Los aptos, del más cercano al más lejano, hasta `ofertasSimultaneas`. */
  aptos: string[];
  /** Cuántos pedidos se le hicieron a location. */
  pedidos: number;
}

/**
 * Lotes crecientes (docs/location.md): location devuelve los más cercanos y dispatch filtra en su base
 * (excluidos y no aptos). Si no alcanzan y el lote vino completo, puede haber aptos más lejos: se pide
 * el doble, hasta 100. Si vino incompleto, no hay más choferes vigentes en el radio.
 *
 * Va FUERA de la transacción, como antes: no se espera a otro servicio con locks tomados. Si un pedido
 * falla, el error de location (503) sube tal cual: no se confunde con «no hay choferes».
 */
export async function buscarAptos(
  deps: Pick<DependenciasDespacho, 'buscador' | 'elegibilidad' | 'parametros' | 'metricas'>,
  origen: Coordenada,
  zonaId: string,
  excluir: readonly string[],
): Promise<ResultadoBusqueda> {
  const necesarios = deps.parametros.ofertasSimultaneas;
  const fuera = new Set(excluir);
  let pedidos = 0;
  let aptos: string[] = [];
  let recibidos = 0;
  let completo = false;
  for (const limite of lotes(necesarios + fuera.size)) {
    pedidos++;
    const r = await deps.buscador.buscar(origen, { limite });
    // `completo` sale de la respuesta original de location, antes de sacar a nadie.
    completo = r.completo;
    recibidos = r.candidatos.length;
    const sinExcluir = r.candidatos.filter((id) => !fuera.has(id));
    aptos = sinExcluir.length ? await deps.elegibilidad.aptos(sinExcluir, zonaId) : [];
    if (aptos.length >= necesarios || !completo) break;
  }
  if (aptos.length === 0) {
    deps.metricas?.busquedaSinAptos?.(recibidos === 0 ? 'sin_candidatos' : completo ? 'tope_agotado' : 'filtrados');
  }
  return { aptos: aptos.slice(0, necesarios), pedidos };
}
