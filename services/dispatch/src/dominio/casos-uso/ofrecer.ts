import { Oferta, type SolicitudViaje } from '../entidades/index.js';
import type { TransaccionDespacho } from '../puertos/index.js';
import type { DependenciasDespacho } from './dependencias.js';

/**
 * Crea una tanda de ofertas para la solicitud (ya bloqueada por el llamador),
 * o la pasa a SIN_CHOFERES si no quedan candidatos.
 */
export async function ofrecerACandidatos(
  tx: TransaccionDespacho,
  solicitud: SolicitudViaje,
  candidatos: string[],
  { ids, reloj, parametros }: Pick<DependenciasDespacho, 'ids' | 'reloj' | 'parametros'>,
): Promise<Oferta[]> {
  if (candidatos.length === 0) {
    solicitud.marcarSinChoferes();
    await tx.guardarSolicitud(solicitud);
    await tx.registrarEvento({
      tipo: 'NoDriversFound',
      payload: { solicitudId: solicitud.id, pasajeroId: solicitud.pasajeroId },
    });
    return [];
  }

  const venceEn = new Date(reloj.ahora().getTime() + parametros.ttlOfertaMs);
  const ofertas = candidatos
    .slice(0, parametros.ofertasSimultaneas)
    .map((choferId) => Oferta.nueva(ids.nuevo(), solicitud.id, choferId, venceEn));
  await tx.guardarOfertas(ofertas);
  for (const o of ofertas) {
    await tx.registrarEvento({
      tipo: 'OfferCreated',
      payload: { ofertaId: o.id, solicitudId: solicitud.id, choferId: o.choferId, venceEn: venceEn.toISOString() },
    });
  }
  return ofertas;
}
