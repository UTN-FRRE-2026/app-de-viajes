import type { Coordenada } from '../../src/dominio/entidades/index.js';
import type { ProveedorTarifas, ServicioMapas } from '../../src/dominio/puertos/index.js';
import type { Recorrido } from '../../src/dominio/tarifas/calculo.js';
import type { ParametrosTarifa } from '../../src/dominio/tarifas/parametros.js';

/** Qué hace el mapas falso en la próxima llamada. */
export type ModoMapas =
  | { recorrido: Recorrido; demoraMs?: number }
  | 'falla'
  /** Nunca contesta: lo corta el timeout. */
  | 'colgado'
  /** Contesta algo que no respeta el contrato (decimales). */
  | 'fuera-de-contrato';

export class MapasFalso implements ServicioMapas {
  modo: ModoMapas = { recorrido: { metros: 5000, segundos: 600 } };
  readonly llamadas: Array<{ origen: Coordenada; destino: Coordenada }> = [];

  async recorrido(origen: Coordenada, destino: Coordenada): Promise<Recorrido> {
    this.llamadas.push({ origen, destino });
    const modo = this.modo;
    if (modo === 'falla') throw new Error('mapas caído');
    if (modo === 'colgado') return new Promise<Recorrido>(() => {});
    if (modo === 'fuera-de-contrato') return { metros: 10.5, segundos: -1 };
    if (modo.demoraMs) await new Promise((r) => setTimeout(r, modo.demoraMs));
    return modo.recorrido;
  }
}

/** Valores redondos para calcular a mano. No son los del `.env`. */
export const PARAMETROS_PRUEBA: ParametrosTarifa = Object.freeze({
  version: 'prueba-1',
  moneda: 'ARS',
  bajadaCentavos: 100_000,
  centavosPorKm: 50_000,
  centavosPorMinuto: 10_000,
  minimoCentavos: 200_000,
  maxMetros: 50_000,
});

export const tarifasFijas = (p: ParametrosTarifa = PARAMETROS_PRUEBA): ProveedorTarifas => ({ vigente: async () => p });
