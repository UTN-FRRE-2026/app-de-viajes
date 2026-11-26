import type { Logger } from '@viajes/platform';
import type { Coordenada } from '../../dominio/entidades/index.js';
import type { Recorrido } from '../../dominio/tarifas/calculo.js';
import type { Ruta, ServicioMapas, ServicioRutas } from '../../dominio/puertos/index.js';

type Mapas = ServicioMapas & ServicioRutas;

/**
 * El ruteo real (OSRM) con un respaldo: si no responde o contesta algo fuera de forma, se usa el
 * simulado (línea recta × desvío). Un servidor de ruteo público caído no deja a nadie sin poder pedir
 * un viaje: la estimación sale con la aproximación de siempre y el mapa dibuja la línea recta.
 *
 * Sigue detrás de `MapasConTimeout` para la estimación: si el respaldo también fallara o tardara, la
 * estimación falla cerrado (503) como antes.
 */
export class MapasConRespaldo implements Mapas {
  constructor(
    private readonly principal: Mapas,
    private readonly respaldo: Mapas,
    private readonly logger: Logger,
    /** Cada vez que se usó el respaldo. Para las métricas. */
    private readonly alUsarRespaldo?: () => void,
  ) {}

  async recorrido(origen: Coordenada, destino: Coordenada): Promise<Recorrido> {
    try {
      return await this.principal.recorrido(origen, destino);
    } catch (err) {
      this.avisar(err);
      return this.respaldo.recorrido(origen, destino);
    }
  }

  async ruta(origen: Coordenada, destino: Coordenada): Promise<Ruta> {
    try {
      return await this.principal.ruta(origen, destino);
    } catch (err) {
      this.avisar(err);
      return this.respaldo.ruta(origen, destino);
    }
  }

  private avisar(err: unknown): void {
    this.alUsarRespaldo?.();
    this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'ruteo: sin respuesta, se usa la línea recta');
  }
}
