import type { GeneradorId, Reloj } from '@viajes/kernel';
import type { EmisorTokens, HasherContrasenas, RepositorioUsuarios } from '../puertos/index.js';

export interface DependenciasIdentidad {
  repo: RepositorioUsuarios;
  hasher: HasherContrasenas;
  emisor: EmisorTokens;
  reloj: Reloj;
  ids: GeneradorId;
}
