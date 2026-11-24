import type { GeneradorId, Reloj } from '@viajes/kernel';
import type {
  BuscadorCandidatos,
  ElegibilidadChoferes,
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
  /** Zona del origen y filtro de candidatos (flotas y zonas, en la base de dispatch). */
  elegibilidad: ElegibilidadChoferes;
  reloj: Reloj;
  ids: GeneradorId;
  parametros: ParametrosDespacho;
  pagos: ProcesadorPagos;
  /** Opcional: sin métricas (por ejemplo, en los tests de dominio) no se registra nada. */
  metricas?: MetricasDespacho;
}
