import type { Reloj } from '@viajes/kernel';
import { exigirCoordenadaValida, type Coordenada } from '../entidades/index.js';
import type { RepositorioUbicaciones } from '../puertos/index.js';

export interface DependenciasUbicacion {
  repo: RepositorioUbicaciones;
  reloj: Reloj;
  /** Una posición más vieja que esto es de un chofer que dejó de reportar (fantasma). */
  vigenciaMs: number;
}

export interface CandidatoCercano {
  choferId: string;
  distanciaMetros: number;
  actualizadaEn: Date;
}

export function crearCasosDeUso(deps: DependenciasUbicacion) {
  return {
    /** El chofer viene del token: nadie puede informar la posición de otro. */
    async registrarUbicacion({ choferId, lat, lng }: { choferId: string } & Coordenada): Promise<void> {
      const posicion = { lat, lng };
      exigirCoordenadaValida(posicion);
      await deps.repo.guardar({ choferId, posicion, registradoEn: deps.reloj.ahora() });
    },

    async buscarCandidatos({
      origen,
      radioMetros,
      limite,
    }: {
      origen: Coordenada;
      radioMetros: number;
      limite: number;
    }): Promise<CandidatoCercano[]> {
      exigirCoordenadaValida(origen);
      const desde = new Date(deps.reloj.ahora().getTime() - deps.vigenciaMs);
      const cercanos = await deps.repo.cercanos({ origen, radioMetros, limite, desde });
      return cercanos.map((c) => ({
        choferId: c.choferId,
        distanciaMetros: Math.round(c.distanciaMetros),
        actualizadaEn: c.registradoEn,
      }));
    },
  };
}

export type CasosDeUso = ReturnType<typeof crearCasosDeUso>;
