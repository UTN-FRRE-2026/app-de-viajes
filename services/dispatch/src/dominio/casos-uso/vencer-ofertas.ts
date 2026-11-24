import { buscarAptos } from './buscar-aptos.js';
import type { DependenciasDespacho } from './dependencias.js';
import { ofrecerACandidatos } from './ofrecer.js';

const LOTE = 100;

/**
 * Barrido de ofertas vencidas. No depende de que el celular del chofer avise nada:
 * el vencimiento lo decide el servidor. Devuelve cuántas solicitudes procesó.
 */
export function vencerOfertas(deps: DependenciasDespacho) {
  return async (): Promise<number> => {
    const ahora = deps.reloj.ahora();
    const ids = await deps.repo.solicitudesConOfertasVencidas(ahora, LOTE);

    for (const id of ids) {
      const actual = await deps.repo.obtenerSolicitud(id);
      if (!actual) continue;
      // Una solicitud de antes de las zonas no tiene la suya: se resuelve desde el origen y se guarda,
      // con las mismas reglas que una nueva. Si quedó fuera de toda zona, no hay a quién ofrecerle.
      const buscando = actual.estado === 'BUSCANDO';
      const zonaId = actual.zonaId ?? (buscando ? await deps.elegibilidad.zonaDelOrigen(actual.origen) : null);
      // Candidatos buscados fuera de la transacción (los aptos de la zona, sin los ya ofrecidos); adentro
      // se vuelve a filtrar con los ofrecidos frescos. Si location falla, el error sube: la solicitud
      // sigue BUSCANDO y el próximo barrido lo vuelve a intentar.
      const candidatos =
        buscando && zonaId ? (await buscarAptos(deps, actual.origen, zonaId, await deps.repo.choferesOfrecidos(id))).aptos : [];

      const vencidasEnEstaSolicitud = await deps.repo.enTransaccion(async (tx) => {
        const solicitud = await tx.obtenerSolicitudParaActualizar(id);
        if (!solicitud) return 0;
        const ofertas = await tx.ofertasDeSolicitud(id);

        const vencidas = ofertas.filter((o) => o.vencerSiCorresponde(ahora));
        await tx.guardarOfertas(vencidas);
        for (const o of vencidas) {
          await tx.registrarEvento({
            tipo: 'OfferExpired',
            payload: { ofertaId: o.id, solicitudId: id, choferId: o.choferId },
          });
        }

        // Nueva tanda solo cuando no queda ninguna oferta vigente de la anterior.
        if (solicitud.estado !== 'BUSCANDO' || ofertas.some((o) => o.estaVigente(ahora))) return vencidas.length;
        if (solicitud.zonaId === null && zonaId) {
          solicitud.fijarZona(zonaId);
          await tx.guardarSolicitud(solicitud);
        }
        const yaOfrecidos = new Set(ofertas.map((o) => o.choferId));
        await ofrecerACandidatos(
          tx,
          solicitud,
          candidatos.filter((c) => !yaOfrecidos.has(c)),
          deps,
        );
        return vencidas.length;
      });
      // Después del COMMIT de cada solicitud: si una transacción falla, sus vencidas no se cuentan.
      if (vencidasEnEstaSolicitud > 0) deps.metricas?.ofertasVencidas(vencidasEnEstaSolicitud);
    }
    return ids.length;
  };
}
