import type { Cobro, DatosCobro } from '../entidades/index.js';
import { CobroNoEncontrado } from '../errores/index.js';
import type { ResultadoCobro } from '../puertos/index.js';
import type { DependenciasDespacho } from './dependencias.js';

/**
 * Procesa un cobro PENDIENTE. Dos garantías contra el doble cobro:
 * 1. Al proveedor se le pasa el id del cobro como clave de idempotencia. Si dos procesos lo llaman
 *    a la vez (el barrido y un pedido, o un reintento), el proveedor cobra una sola vez y les devuelve
 *    a los dos el mismo resultado.
 * 2. El resultado se registra con el cobro bloqueado (FOR UPDATE) y solo si sigue PENDIENTE: el
 *    segundo en llegar ve que ya está resuelto y no registra otro evento.
 *
 * La llamada al proveedor va FUERA de la transacción. Si falla o no contesta, el cobro sigue
 * PENDIENTE (falla cerrado), se anota el intento y el error llega al llamador (503).
 */
async function procesar(deps: DependenciasDespacho, cobro: Cobro): Promise<DatosCobro> {
  let resultado: ResultadoCobro;
  try {
    resultado = await deps.pagos.cobrar({
      clave: cobro.id,
      montoCentavos: cobro.montoCentavos,
      moneda: cobro.moneda,
      pasajeroId: cobro.pasajeroId,
    });
  } catch (err) {
    await deps.repo.registrarFalloCobro(cobro.id, err instanceof Error ? err.message : String(err));
    throw err;
  }

  return deps.repo.enTransaccion(async (tx) => {
    const actual = await tx.obtenerCobroParaActualizar(cobro.solicitudId);
    if (!actual) throw new CobroNoEncontrado();
    // Otro proceso lo resolvió mientras esperábamos al proveedor: con la misma clave, el mismo resultado.
    if (actual.estado !== 'PENDIENTE') return actual.aDatos();

    const comun = {
      cobroId: actual.id,
      solicitudId: actual.solicitudId,
      pasajeroId: actual.pasajeroId,
      montoCentavos: actual.montoCentavos,
      moneda: actual.moneda,
      referencia: resultado.referencia,
    };
    if (resultado.aprobado) {
      actual.aprobar(resultado.referencia);
      await tx.registrarEvento({ tipo: 'PaymentCaptured', payload: comun });
    } else {
      const motivo = resultado.motivo ?? 'rechazado por el proveedor';
      actual.rechazar(resultado.referencia, motivo);
      await tx.registrarEvento({ tipo: 'PaymentDeclined', payload: { ...comun, motivo } });
    }
    await tx.guardarCobro(actual);
    return actual.aDatos();
  });
}

export interface EntradaCobrar {
  solicitudId: string;
  usuarioId: string;
  /** Operador y admin pueden reintentar el cobro de cualquier viaje. */
  veTodos: boolean;
}

/**
 * `POST /solicitudes/:id/cobrar`: procesa el cobro ahora, sin esperar al barrido. Si ya está
 * aprobado o rechazado, lo devuelve como está: llamarlo de nuevo nunca cobra otra vez.
 */
export function cobrarViaje(deps: DependenciasDespacho) {
  return async ({ solicitudId, usuarioId, veTodos }: EntradaCobrar): Promise<DatosCobro> => {
    const cobro = await deps.repo.obtenerCobro(solicitudId);
    // El cobro de otro pasajero responde igual que uno inexistente.
    if (!cobro || (!veTodos && cobro.pasajeroId !== usuarioId)) throw new CobroNoEncontrado();
    if (cobro.estado !== 'PENDIENTE') return cobro.aDatos();
    return procesar(deps, cobro);
  };
}

/**
 * Lo que corre el barrido: procesa los cobros PENDIENTES, primero los que hace más que no se intentan.
 * Un cobro que falla queda para un próximo barrido, al final de la cola: si unos pocos fallan siempre,
 * no impiden que se cobren los demás. Devuelve cuántos quedaron resueltos.
 */
export function cobrarPendientes(deps: DependenciasDespacho) {
  return async (limite = 20): Promise<number> => {
    let resueltos = 0;
    for (const solicitudId of await deps.repo.cobrosPendientes(limite)) {
      const cobro = await deps.repo.obtenerCobro(solicitudId);
      if (cobro?.estado !== 'PENDIENTE') continue;
      try {
        await procesar(deps, cobro);
        resueltos++;
      } catch {
        // Proveedor caído: ya quedó anotado el intento; se reintenta en el próximo barrido.
      }
    }
    return resueltos;
  };
}
