import { CandidatosRespuesta, ENCABEZADO_TOKEN_SERVICIO } from '@viajes/contracts';
import { crearClienteInterno, ErrorHttp, ErrorServicioInterno, type ClienteInterno, type Logger } from '@viajes/platform';
import type { Coordenada } from '../../dominio/entidades/index.js';
import type { BuscadorCandidatos } from '../../dominio/puertos/index.js';

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
 * Pide exactamente `limite` y devuelve lo que vino, sin filtrar: `completo` dice si location devolvió
 * tantos como se le pidieron (con menos, no hay más choferes vigentes en el radio). location no sabe a
 * quién ya se le ofreció ni de flotas y zonas: los lotes crecientes y el filtro van en el dominio
 * (`buscarAptos`).
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

  async buscar(origen: Coordenada, { limite }: { limite: number }) {
    const candidatos = await this.consultar(origen, limite);
    return { candidatos, completo: candidatos.length >= limite };
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
