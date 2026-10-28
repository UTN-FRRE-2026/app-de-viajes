import { Oferta, SolicitudViaje, type DatosOferta, type DatosSolicitud } from '../../dominio/entidades/index.js';
import type { EventoDispatch, RepositorioDespacho, TransaccionDespacho } from '../../dominio/puertos/index.js';

/** Cola de espera simple: quien llega segundo espera a que el primero suelte. */
class Mutex {
  private cola: Promise<void> = Promise.resolve();

  async tomar(): Promise<() => void> {
    let soltar!: () => void;
    const turno = new Promise<void>((r) => (soltar = r));
    const anterior = this.cola;
    this.cola = anterior.then(() => turno);
    await anterior;
    return soltar;
  }
}

const ACTIVAS = new Set(['BUSCANDO', 'ASIGNADO']);

/**
 * Adaptador en memoria para los tests de dominio y para correr sin Postgres.
 * Emula lo que la base garantiza en el adaptador real:
 * - FOR UPDATE → un mutex por solicitud, retenido hasta el final de la transacción;
 * - restricciones únicas (chofer activo, solicitud activa por pasajero) → reservas pendientes
 *   visibles para todas las transacciones, que se liberan si la transacción falla;
 * - atomicidad → las escrituras quedan en un borrador y se aplican solo al confirmar.
 * Diferencia con Postgres: acá el segundo que choca con una reserva pendiente falla enseguida,
 * en Postgres espera a ver si el primero confirma o hace rollback.
 */
export class RepositorioDespachoMemoria implements RepositorioDespacho {
  readonly solicitudes = new Map<string, DatosSolicitud>();
  readonly ofertas = new Map<string, DatosOferta>();
  /** choferId → solicitudId */
  readonly asignaciones = new Map<string, string>();
  readonly eventos: EventoDispatch[] = [];

  private readonly locks = new Map<string, Mutex>();
  private readonly choferesReservados = new Set<string>();
  private readonly pasajerosReservados = new Set<string>();

  async obtenerSolicitud(id: string) {
    const d = this.solicitudes.get(id);
    return d ? SolicitudViaje.reconstruir(d) : null;
  }

  async obtenerOferta(id: string) {
    const d = this.ofertas.get(id);
    return d ? Oferta.reconstruir(d) : null;
  }

  async solicitudesConOfertasVencidas(ahora: Date, limite: number) {
    const ids = new Set<string>();
    for (const o of this.ofertas.values()) {
      if (o.estado === 'PENDIENTE' && o.venceEn <= ahora) ids.add(o.solicitudId);
    }
    return [...ids].slice(0, limite);
  }

  async choferesOfrecidos(solicitudId: string) {
    return [...this.ofertas.values()].filter((o) => o.solicitudId === solicitudId).map((o) => o.choferId);
  }

  async enTransaccion<T>(trabajo: (tx: TransaccionDespacho) => Promise<T>): Promise<T> {
    const soltar: Array<() => void> = [];
    const tomados = new Set<string>();
    const solicitudes = new Map<string, DatosSolicitud>();
    const ofertas = new Map<string, DatosOferta>();
    const eventos: EventoDispatch[] = [];
    const reservas = new Map<string, string>();
    const liberadas = new Set<string>();
    const pasajeros = new Set<string>();

    const leerSolicitud = (id: string) => solicitudes.get(id) ?? this.solicitudes.get(id);

    const tx: TransaccionDespacho = {
      obtenerSolicitudParaActualizar: async (id) => {
        if (!tomados.has(id)) {
          let mutex = this.locks.get(id);
          if (!mutex) this.locks.set(id, (mutex = new Mutex()));
          soltar.push(await mutex.tomar());
          tomados.add(id);
        }
        const d = leerSolicitud(id);
        return d ? SolicitudViaje.reconstruir(d) : null;
      },
      ofertasDeSolicitud: async (solicitudId) => {
        const todas = new Map(this.ofertas);
        for (const [id, o] of ofertas) todas.set(id, o);
        return [...todas.values()].filter((o) => o.solicitudId === solicitudId).map((o) => Oferta.reconstruir(o));
      },
      insertarSolicitud: async (s) => {
        const yaActiva = [...this.solicitudes.values()].some(
          (o) => o.pasajeroId === s.pasajeroId && ACTIVAS.has(o.estado),
        );
        if (yaActiva || this.pasajerosReservados.has(s.pasajeroId)) return false;
        this.pasajerosReservados.add(s.pasajeroId);
        pasajeros.add(s.pasajeroId);
        solicitudes.set(s.id, s.aDatos());
        return true;
      },
      guardarSolicitud: async (s) => {
        solicitudes.set(s.id, s.aDatos());
      },
      guardarOfertas: async (lista) => {
        for (const o of lista) ofertas.set(o.id, o.aDatos());
      },
      reservarChofer: async (choferId, solicitudId) => {
        if (this.asignaciones.has(choferId) || this.choferesReservados.has(choferId)) return false;
        this.choferesReservados.add(choferId);
        reservas.set(choferId, solicitudId);
        return true;
      },
      liberarChofer: async (solicitudId) => {
        liberadas.add(solicitudId);
      },
      registrarEvento: async (e) => {
        eventos.push(e);
      },
    };

    try {
      const resultado = await trabajo(tx);
      // Confirmar: todo junto, sin await en el medio (atómico en un event loop de un solo hilo).
      for (const [choferId, solicitudId] of this.asignaciones) {
        if (liberadas.has(solicitudId)) this.asignaciones.delete(choferId);
      }
      for (const [choferId, solicitudId] of reservas) this.asignaciones.set(choferId, solicitudId);
      for (const [id, d] of solicitudes) this.solicitudes.set(id, d);
      for (const [id, d] of ofertas) this.ofertas.set(id, d);
      this.eventos.push(...eventos);
      return resultado;
    } finally {
      for (const c of reservas.keys()) this.choferesReservados.delete(c);
      for (const p of pasajeros) this.pasajerosReservados.delete(p);
      for (const s of soltar) s();
    }
  }
}
