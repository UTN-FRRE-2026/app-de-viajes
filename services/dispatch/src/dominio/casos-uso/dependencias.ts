import type { GeneradorId, Reloj } from '@viajes/kernel';
import type { BuscadorCandidatos, MetricasDespacho, ParametrosDespacho, RepositorioDespacho } from '../puertos/index.js';

export interface DependenciasDespacho {
  repo: RepositorioDespacho;
  buscador: BuscadorCandidatos;
  reloj: Reloj;
  ids: GeneradorId;
  parametros: ParametrosDespacho;
  /** Opcional: sin métricas (por ejemplo, en los tests de dominio) no se registra nada. */
  metricas?: MetricasDespacho;
}
