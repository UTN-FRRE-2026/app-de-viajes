import type { EstimacionRespuesta } from '@viajes/contracts';
import { create } from 'zustand';
import { nuevaClave, pedir } from '../../api/cliente';
import { esIncierto } from '../../api/operacion';
import type { Punto, Solicitud } from '../../viaje/viaje';
import {
  aplicarEvento,
  aplicarLectura,
  aplicarRespuesta,
  ESTADO_INICIAL,
  esActivo,
  textoRechazoPedido,
  type Cobro,
  type EstadoPasajero,
  type ListadoViajes,
} from './logica';

/** La estimación del recorrido elegido. `para` identifica el recorrido: una respuesta de otro se descarta. */
export interface Estimacion {
  para: string;
  cargando: boolean;
  datos: EstimacionRespuesta | null;
  error: unknown;
}

interface StorePasajero extends EstadoPasajero {
  estimacion: Estimacion | null;
  /** Un pedido que la API rechazó por un motivo que no es uno de los conocidos. */
  errorPedido: unknown;
  consultaCobro: { cargando: boolean; error: unknown };
  /** Vuelve al estado inicial y descarta lo que llegue de pedidos anteriores (al entrar y al salir). */
  reiniciar(): void;
  /** Relee la primera página del historial. Las relecturas se juntan: una en vuelo y, como mucho, otra pendiente. */
  releer(): Promise<void>;
  evento(tipo: string, datos: unknown): void;
  estimar(origen: Punto | null, destino: Punto | null): Promise<void>;
  pedirViaje(origen: Punto, destino: Punto): void;
  /** Reintenta el pedido incierto con la MISMA clave. */
  reintentarPedido(): void;
  descartarPedido(): void;
  cancelar(): void;
  reintentarCancelacion(): void;
  /** Consulta el cobro del viaje terminado (y lo intenta si sigue pendiente: nunca cobra dos veces). */
  consultarCobro(): Promise<void>;
  /** Cierra el viaje terminado y vuelve al formulario. */
  nuevoViaje(): void;
  cerrarAviso(): void;
}

const claveRecorrido = (o: Punto, d: Punto) => `${o.lat},${o.lng}>${d.lat},${d.lng}`;

// Fuera del estado: no hace falta redibujar por ellos.
let marca = 0;
const siguienteMarca = () => ++marca;
let generacion = 0;
let enVuelo = false;
let pendiente = false;

const COBRO_INICIAL = { cargando: false, error: null };

export const usePasajero = create<StorePasajero>()((set, get) => {
  async function enviarPedido() {
    const g = generacion;
    const p = get().pedido;
    if (!p) return;
    try {
      const s = await pedir<Solicitud>('POST', '/viajes/solicitudes', { cuerpo: { origen: p.origen, destino: p.destino }, clave: p.clave });
      if (g !== generacion) return;
      set((e) => ({ ...aplicarRespuesta(e, s, siguienteMarca(), Date.now()), pedido: null }));
    } catch (err) {
      if (g !== generacion) return;
      if (esIncierto(err)) set((e) => ({ pedido: e.pedido && { ...e.pedido, fase: 'incierta', error: err } }));
      // Rechazo definitivo: no se creó. El conocido va como aviso; el resto, con su código de seguimiento.
      else set({ pedido: null, aviso: textoRechazoPedido(err), errorPedido: textoRechazoPedido(err) ? null : err });
    }
    void get().releer();
  }

  async function enviarCancelacion() {
    const g = generacion;
    const c = get().cancelacion;
    if (!c) return;
    try {
      const s = await pedir<Solicitud>('POST', `/viajes/solicitudes/${c.solicitudId}/cancelar`, { cuerpo: {}, clave: c.clave });
      if (g !== generacion) return;
      set((e) => ({ ...aplicarRespuesta(e, s, siguienteMarca(), Date.now()), cancelacion: null }));
    } catch (err) {
      if (g !== generacion) return;
      if (esIncierto(err)) set((e) => ({ cancelacion: e.cancelacion && { ...e.cancelacion, fase: 'incierta', error: err } }));
      else set({ cancelacion: null, aviso: 'El viaje ya había cambiado y no se pudo cancelar: se actualizó la pantalla.' });
    }
    void get().releer();
  }

  return {
    ...ESTADO_INICIAL,
    estimacion: null,
    errorPedido: null,
    consultaCobro: COBRO_INICIAL,

    reiniciar() {
      generacion++;
      enVuelo = false;
      pendiente = false;
      set({ ...ESTADO_INICIAL, estimacion: null, errorPedido: null, consultaCobro: COBRO_INICIAL });
    },

    async releer() {
      if (enVuelo) {
        pendiente = true;
        return;
      }
      enVuelo = true;
      const g = generacion;
      try {
        do {
          pendiente = false;
          const inicio = siguienteMarca();
          try {
            const r = await pedir<ListadoViajes>('GET', '/viajes/historial?limite=5');
            if (g !== generacion) return;
            const { estado, descartada } = aplicarLectura(get(), r.viajes, inicio);
            set(estado);
            if (descartada) pendiente = true;
          } catch (err) {
            if (g !== generacion) return;
            set({ errorLectura: err });
          }
        } while (pendiente);
      } finally {
        if (g === generacion) enVuelo = false;
      }
    },

    evento(tipo, datos) {
      const { estado, releer } = aplicarEvento(get(), tipo, datos, Date.now());
      set(estado);
      if (releer) void get().releer();
    },

    async estimar(origen, destino) {
      if (!origen || !destino) {
        set({ estimacion: null });
        return;
      }
      const para = claveRecorrido(origen, destino);
      if (get().estimacion?.para === para && !get().estimacion?.error) return;
      set({ estimacion: { para, cargando: true, datos: null, error: null } });
      const q = new URLSearchParams({
        origenLat: String(origen.lat),
        origenLng: String(origen.lng),
        destinoLat: String(destino.lat),
        destinoLng: String(destino.lng),
      });
      try {
        const datos = await pedir<EstimacionRespuesta>('GET', `/viajes/tarifas/estimacion?${q}`);
        if (get().estimacion?.para === para) set({ estimacion: { para, cargando: false, datos, error: null } });
      } catch (error) {
        if (get().estimacion?.para === para) set({ estimacion: { para, cargando: false, datos: null, error } });
      }
    },

    pedirViaje(origen, destino) {
      if (get().pedido || (get().viaje && esActivo(get().viaje!))) return;
      set({ pedido: { origen, destino, clave: nuevaClave(), fase: 'enviando', error: null }, aviso: null, errorPedido: null });
      void enviarPedido();
    },

    reintentarPedido() {
      const p = get().pedido;
      if (!p || p.fase === 'enviando') return;
      set({ pedido: { ...p, fase: 'enviando', error: null } });
      void enviarPedido();
    },

    descartarPedido: () => set({ pedido: null }),

    cancelar() {
      const { viaje, cancelacion } = get();
      if (!viaje || !esActivo(viaje) || cancelacion) return;
      set({ cancelacion: { solicitudId: viaje.id, clave: nuevaClave(), fase: 'enviando', error: null }, aviso: null });
      void enviarCancelacion();
    },

    reintentarCancelacion() {
      const c = get().cancelacion;
      if (!c || c.fase === 'enviando') return;
      set({ cancelacion: { ...c, fase: 'enviando', error: null } });
      void enviarCancelacion();
    },

    async consultarCobro() {
      const viaje = get().viaje;
      if (!viaje || viaje.estado !== 'COMPLETADA') return;
      const g = generacion;
      set({ consultaCobro: { cargando: true, error: null } });
      try {
        // Idempotente por la solicitud: si ya se resolvió, la API lo devuelve como está.
        const cobro = await pedir<Cobro>('POST', `/viajes/solicitudes/${viaje.id}/cobrar`, { cuerpo: {}, clave: nuevaClave() });
        if (g !== generacion || get().viaje?.id !== viaje.id) return;
        set((e) => ({
          cobro,
          consultaCobro: COBRO_INICIAL,
          horas: cobro.estado === 'APROBADO' && e.horas.cobrado === undefined ? { ...e.horas, cobrado: Date.now() } : e.horas,
        }));
      } catch (error) {
        if (g !== generacion) return;
        set({ consultaCobro: { cargando: false, error } });
      }
    },

    nuevoViaje() {
      const v = get().viaje;
      if (v && esActivo(v)) return;
      set({ viaje: null, creadaEn: null, horas: {}, posicionChofer: null, cobro: null, aviso: null, consultaCobro: COBRO_INICIAL });
    },

    cerrarAviso: () => set({ aviso: null }),
  };
});
