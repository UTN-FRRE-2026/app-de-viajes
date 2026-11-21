import type { GeneradorId, Reloj } from '@viajes/kernel';
import type {
  BuscadorCandidatos,
  MetricasDespacho,
  ParametrosDespacho,
  ProcesadorPagos,
  RepositorioDespacho,
} from '../puertos/index.js';
import type { DependenciasTarifas } from './estimar-tarifa.js';
import type { DependenciasTarifasAdmin } from './tarifas-admin.js';

export interface DependenciasDespacho extends DependenciasTarifas, DependenciasTarifasAdmin {
  repo: RepositorioDespacho;
  buscador: BuscadorCandidatos;
  reloj: Reloj;
  ids: GeneradorId;
  parametros: ParametrosDespacho;
  pagos: ProcesadorPagos;
  /** Opcional: sin métricas (por ejemplo, en los tests de dominio) no se registra nada. */
  metricas?: MetricasDespacho;
}
