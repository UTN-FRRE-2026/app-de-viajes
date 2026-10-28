import type { RepositorioDespacho, TransaccionDespacho } from '../../src/dominio/puertos/index.js';

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Agranda la ventana de la carrera: cada transacción espera `ms` justo después de leer la solicitud.
 * Sin esto, una transacción dura ~1 ms y los pedidos llegan escalonados, así que el test de
 * 50 aceptaciones podía pasar aunque faltara el FOR UPDATE (lo comprobamos sacándolo).
 * Con la demora, sin lock varias transacciones leen BUSCANDO a la vez; con lock esperan en fila.
 */
export function conDemoraTrasLeer(repo: RepositorioDespacho, ms: number): RepositorioDespacho {
  return {
    obtenerSolicitud: (id) => repo.obtenerSolicitud(id),
    obtenerOferta: (id) => repo.obtenerOferta(id),
    solicitudesConOfertasVencidas: (ahora, limite) => repo.solicitudesConOfertasVencidas(ahora, limite),
    choferesOfrecidos: (id) => repo.choferesOfrecidos(id),
    enTransaccion: (trabajo) =>
      repo.enTransaccion((tx) =>
        trabajo({
          ...tx,
          obtenerSolicitudParaActualizar: async (id) => {
            const s = await tx.obtenerSolicitudParaActualizar(id);
            await dormir(ms);
            return s;
          },
        } satisfies TransaccionDespacho),
      ),
  };
}
