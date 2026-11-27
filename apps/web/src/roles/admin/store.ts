import { create } from 'zustand';
import { pedir } from '../../api/cliente';
import { ClavesDeOperacion, esIncierto } from '../../api/operacion';
import { agregarReciente, normalizarCodigo, objetivoHabilitacion, type Accion, type Chofer } from './logica';

/**
 * Una habilitación o deshabilitación. `incierta`: no se sabe si se aplicó (red, 5xx o la clave
 * todavía en curso); el reintento usa la MISMA clave. La API no tiene un `GET` del chofer para el
 * admin, así que no se verifica: las dos acciones son idempotentes y reintentar es seguro.
 */
export interface Operacion {
  choferId: string;
  accion: Accion;
  fase: 'enviando' | 'incierta' | 'error' | 'listo';
  error: unknown;
  /** El chofer como quedó (con `listo`). */
  resultado: Chofer | null;
}

interface StoreHabilitacion {
  /** La última operación: una a la vez. */
  operacion: Operacion | null;
  /** Los choferes que se tocaron en esta pantalla, el último primero. */
  recientes: Chofer[];
  reiniciar(): void;
  enviar(codigo: string, accion: Accion): void;
  /** Reintenta la operación incierta con la MISMA clave. */
  reintentar(): void;
  /** Abandona una operación incierta: cierra su clave y libera el formulario. */
  descartar(): void;
}

let generacion = 0;
const claves = new ClavesDeOperacion();

/** Mientras hay una en vuelo o incierta, no se empieza otra. */
export const ocupada = (op: Operacion | null) => op !== null && (op.fase === 'enviando' || op.fase === 'incierta');

export const useHabilitacion = create<StoreHabilitacion>()((set, get) => {
  async function mandar(): Promise<void> {
    const g = generacion;
    const op = get().operacion;
    if (!op) return;
    const objetivo = objetivoHabilitacion(op.choferId, op.accion);
    try {
      const c = await pedir<Chofer>('POST', `/viajes/admin/choferes/${op.choferId}/${op.accion}`, { cuerpo: {}, clave: claves.para(objetivo) });
      if (g !== generacion) return;
      claves.cerrar(objetivo);
      set((e) => ({ operacion: { ...op, fase: 'listo', error: null, resultado: c }, recientes: agregarReciente(e.recientes, c) }));
    } catch (err) {
      if (g !== generacion) return;
      if (!esIncierto(err)) {
        // Definitivo (404: no está en ninguna flota): no se aplicó.
        claves.cerrar(objetivo);
        set({ operacion: { ...op, fase: 'error', error: err } });
      } else {
        set({ operacion: { ...op, fase: 'incierta', error: err } });
      }
    }
  }

  return {
    operacion: null,
    recientes: [],

    reiniciar() {
      generacion++;
      set({ operacion: null, recientes: [] });
    },

    enviar(codigo, accion) {
      if (ocupada(get().operacion)) return;
      set({ operacion: { choferId: normalizarCodigo(codigo), accion, fase: 'enviando', error: null, resultado: null } });
      void mandar();
    },

    reintentar() {
      const op = get().operacion;
      if (!op || op.fase !== 'incierta') return;
      set({ operacion: { ...op, fase: 'enviando', error: null } });
      void mandar();
    },

    descartar() {
      const op = get().operacion;
      if (!op || op.fase !== 'incierta') return;
      claves.cerrar(objetivoHabilitacion(op.choferId, op.accion));
      set({ operacion: null });
    },
  };
});
