import type { Reloj } from '@viajes/kernel';
import { exigirCoordenadaValida, type Coordenada, type Ping } from '../entidades/index.js';
import type { PublicadorPosiciones, RepositorioUbicaciones, ResultadoPublicacion } from '../puertos/index.js';

export interface DependenciasUbicacion {
  repo: RepositorioUbicaciones;
  reloj: Reloj;
  /** Una posición más vieja que esto es de un chofer que dejó de reportar (fantasma). */
  vigenciaMs: number;
  /** Posición en vivo. Sin publicador (sin Redis), el seguimiento queda desactivado. */
  publicador?: PublicadorPosiciones;
  /** Para métricas y log: qué pasó con cada publicación. `err` solo con `error`. */
  alPublicar?: (resultado: ResultadoPublicacion, err?: unknown) => void;
}

export interface CandidatoCercano {
  choferId: string;
  distanciaMetros: number;
  actualizadaEn: Date;
}

export function crearCasosDeUso(deps: DependenciasUbicacion) {
  /**
   * Publica la posición recién guardada. Nunca lanza: una falla de publicación no compromete el
   * registro del ping, que ya está guardado. El canal puede quedar atrasado respecto del
   * repositorio hasta el próximo ping que se publique.
   */
  async function publicar(ping: Ping): Promise<void> {
    if (!deps.publicador) return;
    // Misma regla que la búsqueda: vigente si registradoEn >= ahora − vigencia. Una más vieja ya es un
    // fantasma (por ejemplo, un guardado que tardó): no se anuncia como la posición actual.
    if (ping.registradoEn.getTime() < deps.reloj.ahora().getTime() - deps.vigenciaMs) {
      deps.alPublicar?.('vencida');
      return;
    }
    try {
      deps.alPublicar?.(await deps.publicador.publicar(ping));
    } catch (err) {
      deps.alPublicar?.('error', err);
    }
  }

  return {
    /** El chofer viene del token: nadie puede informar la posición de otro. */
    async registrarUbicacion({ choferId, lat, lng }: { choferId: string } & Coordenada): Promise<void> {
      const posicion = { lat, lng };
      exigirCoordenadaValida(posicion);
      const ping = { choferId, posicion, registradoEn: deps.reloj.ahora() };
      await deps.repo.guardar(ping);
      // Después de guardar: si el guardado falla, no se anuncia nada.
      await publicar(ping);
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
