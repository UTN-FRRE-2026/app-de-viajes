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
      // Candidatos buscados fuera de la transacción; adentro se vuelve a filtrar con datos frescos.
      const candidatos =
        actual.estado === 'BUSCANDO'
          ? await deps.buscador.buscar(actual.origen, {
              excluir: await deps.repo.choferesOfrecidos(id),
              limite: deps.parametros.ofertasSimultaneas,
            })
          : [];

      await deps.repo.enTransaccion(async (tx) => {
        const solicitud = await tx.obtenerSolicitudParaActualizar(id);
        if (!solicitud) return;
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
        if (solicitud.estado !== 'BUSCANDO' || ofertas.some((o) => o.estaVigente(ahora))) return;
        const yaOfrecidos = new Set(ofertas.map((o) => o.choferId));
        await ofrecerACandidatos(
          tx,
          solicitud,
          candidatos.filter((c) => !yaOfrecidos.has(c)),
          deps,
        );
      });
    }
    return ids.length;
  };
}
