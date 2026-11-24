import type { RepositorioFlotas, TransaccionFlotas } from '../../src/dominio/puertos/index.js';

type Tras = { [K in keyof TransaccionFlotas]?: () => Promise<void> };

/**
 * Agranda la ventana de una carrera de flotas sin tocar el adaptador: cada operación de la transacción
 * que figure en `tras` corre igual y, después, espera lo que devuelva su función (dentro de la
 * transacción, con sus locks tomados y su escritura sin confirmar). Por ejemplo, `ocuparCupo` con el
 * contador ya sumado, o `insertarChofer` con la fila insertada.
 *
 * `tras` se lee en cada llamada: el test puede prender y apagar las demoras entre un caso y otro.
 */
export function conDemorasFlotas(repo: RepositorioFlotas, tras: Tras): RepositorioFlotas {
  const envolver = (tx: TransaccionFlotas): TransaccionFlotas => {
    const envuelta = { ...tx } as Record<string, unknown>;
    for (const nombre of Object.keys(tx) as (keyof TransaccionFlotas)[]) {
      const original = tx[nombre] as (...args: unknown[]) => Promise<unknown>;
      envuelta[nombre] = async (...args: unknown[]) => {
        const resultado = await original(...args);
        await tras[nombre]?.();
        return resultado;
      };
    }
    return envuelta as unknown as TransaccionFlotas;
  };
  return {
    enTransaccion: (trabajo) => repo.enTransaccion((tx) => trabajo(envolver(tx))),
    obtenerFlota: (id) => repo.obtenerFlota(id),
    obtenerChofer: (id) => repo.obtenerChofer(id),
    listarChoferes: (flotaId, pagina) => repo.listarChoferes(flotaId, pagina),
    listarZonas: () => repo.listarZonas(),
    zonasDeFlota: (flotaId) => repo.zonasDeFlota(flotaId),
  };
}
