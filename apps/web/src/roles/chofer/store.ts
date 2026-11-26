import type { ChoferFlotaRespuesta } from '@viajes/contracts';
import { create } from 'zustand';
import { nuevaClave, pedir } from '../../api/cliente';
import { ClavesDeOperacion, esIncierto } from '../../api/operacion';
import type { EstadoChoferRespuesta, OfertaPendiente, Solicitud } from '../../viaje/viaje';
import {
  aplicarEvento,
  aplicarLectura,
  aplicarRespuesta,
  claveAutomatica,
  ESTADO_INICIAL,
  puedeAvanzarSolo,
  SIGUIENTE,
  textoRechazoAceptacion,
  type AccionViaje,
  type EstadoChofer,
} from './logica';

/** El cambio de disponibilidad en curso o fallido: el reintento usa la misma clave (`ClavesDeOperacion`). */
export interface CambioDisponibilidad {
  enviando: boolean;
  valor: boolean | null;
  error: unknown;
}

interface StoreChofer extends EstadoChofer {
  disponibilidad: CambioDisponibilidad;
  /** Vuelve al estado inicial y descarta lo que llegue de pedidos anteriores (al entrar y al salir). */
  reiniciar(): void;
  /** Relee `GET /chofer/estado`. Las relecturas se juntan: una en vuelo y, como mucho, otra pendiente. */
  releer(): Promise<void>;
  evento(tipo: string, datos: unknown): void;
  aceptar(oferta: OfertaPendiente): void;
  /** Reintenta la aceptación incierta con la MISMA clave. */
  reintentarAceptacion(): void;
  /** La acción que sigue según el estado del viaje: en camino, iniciar o finalizar. */
  avanzar(): void;
  /**
   * Conducción simulada: pide `accion` sola, una vez por viaje (`puedeAvanzarSolo`). Va por `avanzar`,
   * con su Idempotency-Key y su resultado incierto.
   */
  avanzarSolo(accion: AccionViaje): void;
  reintentarOperacion(): void;
  cambiarDisponible(valor: boolean): Promise<void>;
  cerrarAviso(): void;
  cerrarResumen(): void;
}

// Fuera del estado: no hace falta redibujar por ellos.
let marca = 0;
/** Un contador creciente: ordena las lecturas respecto de las respuestas de las acciones. */
const siguienteMarca = () => ++marca;
let generacion = 0;
let enVuelo = false;
let pendiente = false;
const claves = new ClavesDeOperacion();

const DISPONIBILIDAD_INICIAL: CambioDisponibilidad = { enviando: false, valor: null, error: null };

export const useChofer = create<StoreChofer>()((set, get) => {
  async function enviarAceptacion() {
    const g = generacion;
    const a = get().aceptacion;
    if (!a) return;
    try {
      const s = await pedir<Solicitud>('POST', `/viajes/ofertas/${a.oferta.ofertaId}/aceptar`, { cuerpo: {}, clave: a.clave });
      if (g !== generacion) return;
      set((e) => ({ ...aplicarRespuesta(e, s, siguienteMarca()), aceptacion: null }));
    } catch (err) {
      if (g !== generacion) return;
      if (esIncierto(err)) {
        // No se sabe si se aceptó: la operación queda, con su clave, aunque la tarjeta desaparezca.
        set((e) => ({ aceptacion: e.aceptacion && { ...e.aceptacion, fase: 'incierta', error: err } }));
      } else {
        set({ aceptacion: null, aviso: textoRechazoAceptacion(err) ?? 'No se pudo aceptar la oferta.' });
      }
    }
    // En cualquier caso, la base dice cómo quedó (si apareció el viaje, la aceptación incierta se resuelve).
    void get().releer();
  }

  async function enviarOperacion() {
    const g = generacion;
    const op = get().operacion;
    if (!op) return;
    try {
      const s = await pedir<Solicitud>('POST', `/viajes/solicitudes/${op.solicitudId}/${op.accion}`, { cuerpo: {}, clave: op.clave });
      if (g !== generacion) return;
      set((e) => ({ ...aplicarRespuesta(e, s, siguienteMarca()), operacion: null }));
    } catch (err) {
      if (g !== generacion) return;
      if (esIncierto(err)) set((e) => ({ operacion: e.operacion && { ...e.operacion, fase: 'incierta', error: err } }));
      else set({ operacion: null, aviso: 'El viaje ya había cambiado: se actualizó la pantalla.' });
    }
    void get().releer();
  }

  return {
    ...ESTADO_INICIAL,
    disponibilidad: DISPONIBILIDAD_INICIAL,

    reiniciar() {
      generacion++;
      enVuelo = false;
      pendiente = false;
      set({ ...ESTADO_INICIAL, disponibilidad: DISPONIBILIDAD_INICIAL });
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
          const enviadaEn = Date.now();
          try {
            const r = await pedir<EstadoChoferRespuesta>('GET', '/viajes/chofer/estado');
            if (g !== generacion) return;
            const { estado, descartada } = aplicarLectura(get(), r, { inicio, enviadaEn, recibidaEn: Date.now() });
            set(estado);
            // Empezó antes de la respuesta de una acción: no sirve, se pide otra.
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
      const { estado, releer } = aplicarEvento(get(), tipo, datos);
      set(estado);
      if (releer) void get().releer();
    },

    aceptar(oferta) {
      if (get().aceptacion) return;
      set({ aceptacion: { oferta, clave: nuevaClave(), fase: 'enviando', error: null }, aviso: null });
      void enviarAceptacion();
    },

    reintentarAceptacion() {
      const a = get().aceptacion;
      if (!a || a.fase === 'enviando') return;
      set({ aceptacion: { ...a, fase: 'enviando', error: null } });
      void enviarAceptacion();
    },

    avanzar() {
      const { viaje, operacion } = get();
      const siguiente = viaje ? SIGUIENTE[viaje.estado] : undefined;
      if (!viaje || !siguiente || operacion) return;
      set({
        operacion: { accion: siguiente.accion, solicitudId: viaje.id, desde: viaje.estado, clave: nuevaClave(), fase: 'enviando', error: null },
        aviso: null,
      });
      void enviarOperacion();
    },

    avanzarSolo(accion) {
      const e = get();
      if (!e.viaje || !puedeAvanzarSolo(e, accion)) return;
      set({ automaticos: [...e.automaticos, claveAutomatica(e.viaje.id, accion)] });
      get().avanzar();
    },

    reintentarOperacion() {
      const op = get().operacion;
      if (!op || op.fase === 'enviando') return;
      set({ operacion: { ...op, fase: 'enviando', error: null } });
      void enviarOperacion();
    },

    async cambiarDisponible(valor) {
      const g = generacion;
      set({ disponibilidad: { enviando: true, valor, error: null } });
      try {
        const registro = await claves.ejecutar(`disponible:${valor}`, (clave) =>
          pedir<ChoferFlotaRespuesta>('PUT', '/viajes/chofer/disponibilidad', { cuerpo: { disponible: valor }, clave }),
        );
        if (g !== generacion) return;
        set({ registro, ultimaMutacion: siguienteMarca(), disponibilidad: DISPONIBILIDAD_INICIAL });
      } catch (err) {
        if (g !== generacion) return;
        set({ disponibilidad: { enviando: false, valor, error: err } });
      }
    },

    cerrarAviso: () => set({ aviso: null }),
    cerrarResumen: () => set({ terminado: null }),
  };
});
