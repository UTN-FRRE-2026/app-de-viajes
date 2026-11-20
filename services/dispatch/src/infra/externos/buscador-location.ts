import {
  CandidatosRespuesta,
  ENCABEZADO_TOKEN_SERVICIO,
  LIMITE_CANDIDATOS_MAX,
} from '@viajes/contracts';
import { crearClienteInterno, ErrorHttp, ErrorServicioInterno, type ClienteInterno, type Logger } from '@viajes/platform';
import type { Coordenada } from '../../dominio/entidades/index.js';
import type { BuscadorCandidatos } from '../../dominio/puertos/index.js';

/** Lote mínimo que se le pide a location, aunque dispatch necesite menos. */
export const LOTE_MINIMO = 10;

export interface OpcionesBuscadorLocation {
  urlBase: string;
  tokenServicio: string;
  timeoutMs: number;
  radioMetros: number;
  logger: Logger;
}

/**
 * Adaptador de `BuscadorCandidatos` contra `GET /interno/candidatos` de location.
 *
 * location no sabe a quién ya se le ofreció el viaje: dispatch pide `limite + excluidos` (como mínimo
 * 10, como máximo el tope del contrato, 100) y filtra. Con ese lote, si location lo devuelve completo,
 * siempre quedan al menos `limite` aptos; si devuelve menos, no hay más choferes vigentes en el radio.
 * Los lotes crecientes de docs/location.md hacen falta recién cuando dispatch filtre también por
 * disponibilidad, flota y zona: ahí el filtro puede descartar más de lo que se pidió de más.
 *
 * Falla cerrado: timeout, error de red, 5xx, 4xx o respuesta fuera de contrato → 503
 * `UBICACION_NO_DISPONIBLE`. La búsqueda va antes de la transacción, así que no queda nada a medias.
 */
export class BuscadorCandidatosLocation implements BuscadorCandidatos {
  private readonly cliente: ClienteInterno;

  constructor(private readonly opciones: OpcionesBuscadorLocation) {
    this.cliente = crearClienteInterno({
      servicio: 'location',
      urlBase: opciones.urlBase,
      timeoutMs: opciones.timeoutMs,
      encabezados: { [ENCABEZADO_TOKEN_SERVICIO]: opciones.tokenServicio },
    });
  }

  async buscar(origen: Coordenada, { excluir, limite }: { excluir: string[]; limite: number }): Promise<string[]> {
    const fuera = new Set(excluir);
    const pedir = Math.min(LIMITE_CANDIDATOS_MAX, Math.max(LOTE_MINIMO, limite + fuera.size));
    const recibidos = await this.consultar(origen, pedir);
    return recibidos.filter((id) => !fuera.has(id)).slice(0, limite);
  }

  private async consultar(origen: Coordenada, limite: number): Promise<string[]> {
    try {
      const { candidatos } = await this.cliente.getJson(
        '/interno/candidatos',
        { lat: origen.lat, lng: origen.lng, limite, radioMetros: this.opciones.radioMetros },
        CandidatosRespuesta,
      );
      return candidatos.map((c) => c.choferId);
    } catch (err) {
      if (!(err instanceof ErrorServicioInterno)) throw err;
      // Un 4xx es un error de programación en dispatch (contrato o token mal configurado): más grave.
      const esNuestro = err.motivo === 'estado' && err.estado !== undefined && err.estado < 500;
      this.opciones.logger[esNuestro ? 'error' : 'warn'](
        { motivo: err.motivo, estado: err.estado, err: err.message },
        'location: no se pudieron buscar candidatos',
      );
      throw new ErrorHttp(503, 'UBICACION_NO_DISPONIBLE', 'No se pueden buscar choferes en este momento');
    }
  }
}
