import { ENCABEZADO_TOKEN_SERVICIO, TramosViajeRespuesta } from '@viajes/contracts';
import { crearClienteInterno, type ClienteInterno } from '@viajes/platform';
import type { TramoDeViaje, TramosDeViaje } from '../../dominio/puertos/index.js';

export interface OpcionesTramosDispatch {
  urlBase: string;
  tokenServicio: string;
  timeoutMs: number;
}

/**
 * `TramosDeViaje` contra `POST /interno/tramos-viaje` de dispatch, con su token de servicio y timeout.
 * Cualquier fallo (timeout, red, estado o contrato) lanza `ErrorServicioInterno`: la retención conserva
 * el lote.
 */
export class TramosDeViajeDispatch implements TramosDeViaje {
  private readonly cliente: ClienteInterno;

  constructor({ urlBase, tokenServicio, timeoutMs }: OpcionesTramosDispatch) {
    this.cliente = crearClienteInterno({
      servicio: 'dispatch',
      urlBase,
      timeoutMs,
      encabezados: { [ENCABEZADO_TOKEN_SERVICIO]: tokenServicio },
    });
  }

  async tramos(choferes: readonly string[], desde: Date, hasta: Date): Promise<TramoDeViaje[]> {
    const { tramos } = await this.cliente.postJson(
      '/interno/tramos-viaje',
      { choferes, desde: desde.toISOString(), hasta: hasta.toISOString() },
      TramosViajeRespuesta,
    );
    return tramos.map((t) => ({ choferId: t.choferId, inicio: new Date(t.inicio), fin: t.fin === null ? null : new Date(t.fin) }));
  }
}
