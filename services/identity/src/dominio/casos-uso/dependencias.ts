import type { GeneradorId, Reloj } from '@viajes/kernel';
import type {
  EmisorTokens,
  GeneradorRefresh,
  HasherContrasenas,
  RepositorioSesiones,
  RepositorioUsuarios,
} from '../puertos/index.js';

export interface DependenciasIdentidad {
  repo: RepositorioUsuarios;
  sesiones: RepositorioSesiones;
  hasher: HasherContrasenas;
  emisor: EmisorTokens;
  refresh: GeneradorRefresh;
  reloj: Reloj;
  ids: GeneradorId;
  refreshTtlSegundos: number;
}
