import {
  Cobro,
  ESTADOS_ACTIVOS,
  Oferta,
  SolicitudViaje,
  type DatosCobro,
  type DatosOferta,
  type RegistroSolicitud,
} from '../../dominio/entidades/index.js';
import type {
  EventoDispatch,
  FiltroSolicitudes,
  Pagina,
  RepositorioDespacho,
  TransaccionDespacho,
} from '../../dominio/puertos/index.js';

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

// Lo mismo que el índice único parcial ride_requests_una_activa_por_pasajero.
const ACTIVAS = new Set(ESTADOS_ACTIVOS);

/**
 * Adaptador en memoria para los tests de dominio y para correr sin Postgres.
 * Emula lo que la base garantiza en el adaptador real:
 * - FOR UPDATE → un mutex por solicitud, retenido hasta el final de la transacción;
 * - FOR UPDATE del cobro → otro mutex, por cobro;
 * - restricciones únicas (chofer activo, solicitud activa por pasajero, un cobro por viaje) → reservas pendientes
 *   visibles para todas las transacciones, que se liberan si la transacción falla;
 * - atomicidad → las escrituras quedan en un borrador y se aplican solo al confirmar.
 * Diferencia con Postgres: acá el segundo que choca con una reserva pendiente falla enseguida,
 * en Postgres espera a ver si el primero confirma o hace rollback.
 */
export class RepositorioDespachoMemoria implements RepositorioDespacho {
  readonly solicitudes = new Map<string, RegistroSolicitud>();
  readonly ofertas = new Map<string, DatosOferta>();
  /** choferId → solicitudId */
  readonly asignaciones = new Map<string, string>();
  readonly eventos: EventoDispatch[] = [];
  /** solicitudId → cobro */
  readonly cobros = new Map<string, DatosCobro & { creadoEn: number }>();

  private readonly locks = new Map<string, Mutex>();
  private readonly choferesReservados = new Set<string>();
  private readonly pasajerosReservados = new Set<string>();

  async obtenerSolicitud(id: string) {
    const d = this.solicitudes.get(id);
    return d ? SolicitudViaje.reconstruir(d) : null;
  }

  async obtenerCobro(solicitudId: string) {
    const d = this.cobros.get(solicitudId);
    return d ? Cobro.reconstruir(d) : null;
  }

  async cobrosPendientes(limite: number) {
    return [...this.cobros.values()]
      .filter((c) => c.estado === 'PENDIENTE')
      .sort((a, b) => a.creadoEn - b.creadoEn)
      .slice(0, limite)
      .map((c) => c.solicitudId);
  }

  async registrarFalloCobro(cobroId: string) {
    for (const c of this.cobros.values()) {
      if (c.id === cobroId && c.estado === 'PENDIENTE') c.intentosFallidos++;
    }
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

  async listarSolicitudes({ pasajeroId, choferId, estados, texto }: FiltroSolicitudes, { limite, desde }: Pagina) {
    const buscado = texto?.toLowerCase();
    const contiene = (valor: string | null) => valor !== null && valor.toLowerCase().includes(buscado as string);
    return [...this.solicitudes.values()]
      .filter(
        (s) =>
          (!pasajeroId || s.pasajeroId === pasajeroId) &&
          (!choferId || s.choferId === choferId) &&
          (!estados || estados.includes(s.estado)) &&
          (!buscado || [s.id, s.pasajeroId, s.choferId, s.motivoCancelacion].some(contiene)),
      )
      // Igual que en Postgres: la más nueva primero y, a igual fecha, por id descendente.
      .sort((a, b) => b.creadaEn.getTime() - a.creadaEn.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(desde, desde + limite)
      .map((d) => SolicitudViaje.reconstruir(d));
  }

  async enTransaccion<T>(trabajo: (tx: TransaccionDespacho) => Promise<T>): Promise<T> {
    const soltar: Array<() => void> = [];
    const tomados = new Set<string>();
    const solicitudes = new Map<string, RegistroSolicitud>();
    const ofertas = new Map<string, DatosOferta>();
    const eventos: EventoDispatch[] = [];
    const reservas = new Map<string, string>();
    const liberadas = new Set<string>();
    const pasajeros = new Set<string>();
    const cobros = new Map<string, DatosCobro>();

    const tomar = async (clave: string) => {
      if (tomados.has(clave)) return;
      let mutex = this.locks.get(clave);
      if (!mutex) this.locks.set(clave, (mutex = new Mutex()));
      soltar.push(await mutex.tomar());
      tomados.add(clave);
    };

    const leerSolicitud = (id: string) => solicitudes.get(id) ?? this.solicitudes.get(id);

    const tx: TransaccionDespacho = {
      obtenerSolicitudParaActualizar: async (id) => {
        await tomar(id);
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
        solicitudes.set(s.id, s.aRegistro());
        return true;
      },
      guardarSolicitud: async (s) => {
        solicitudes.set(s.id, s.aRegistro());
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
      insertarCobro: async (c) => {
        if (this.cobros.has(c.solicitudId) || cobros.has(c.solicitudId)) {
          throw new Error('payments_request_id_key: el viaje ya tiene un cobro');
        }
        cobros.set(c.solicitudId, c.aDatos());
      },
      obtenerCobroParaActualizar: async (solicitudId) => {
        await tomar(`cobro:${solicitudId}`);
        const d = cobros.get(solicitudId) ?? this.cobros.get(solicitudId);
        return d ? Cobro.reconstruir(d) : null;
      },
      guardarCobro: async (c) => {
        cobros.set(c.solicitudId, c.aDatos());
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
      for (const [id, d] of cobros) this.cobros.set(id, { ...d, creadoEn: this.cobros.get(id)?.creadoEn ?? Date.now() });
      return resultado;
    } finally {
      for (const c of reservas.keys()) this.choferesReservados.delete(c);
      for (const p of pasajeros) this.pasajerosReservados.delete(p);
      for (const s of soltar) s();
    }
  }
}
