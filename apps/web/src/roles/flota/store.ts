import { create } from 'zustand';
import { pedir } from '../../api/cliente';
import { ClavesDeOperacion, esIncierto } from '../../api/operacion';
import {
  aplicarChofer,
  aplicarFlota,
  aplicarLecturaChofer,
  aplicarPagina,
  aplicarReporte,
  LISTA_INICIAL,
  limiteRecarga,
  normalizarAlta,
  objetivoAlta,
  PAGINA,
  pedirReporte,
  REPORTE_INICIAL,
  vehiculoCoincide,
  type Chofer,
  type DatosAlta,
  type EstadoLista,
  type Flota,
  type PaginaChoferes,
  type Periodo,
  type Reporte,
  type EstadoReporte,
} from './logica';

export type Accion = 'activar' | 'desactivar';

/**
 * Activar o desactivar a un chofer. `incierta`: no se sabe si se aplicó (red, 5xx o la clave todavía
 * en curso) y la relectura del chofer no lo confirmó; el reintento usa la MISMA clave.
 */
export interface Operacion {
  accion: Accion;
  fase: 'enviando' | 'verificando' | 'incierta' | 'error';
  error: unknown;
}

/**
 * El alta en curso. `listo`: el chofer quedó en la flota con el vehículo enviado. `difiere`: el chofer
 * está en la flota, pero con otro vehículo (se muestra el real). `incierta`: no se sabe; el reintento
 * usa la MISMA clave.
 */
export interface Alta {
  datos: DatosAlta;
  fase: 'enviando' | 'verificando' | 'incierta' | 'error' | 'listo' | 'difiere';
  error: unknown;
  real: Chofer | null;
}

interface StoreFlota extends EstadoLista {
  /** La primera página ya llegó (con `flota`, la pantalla está cargada). */
  listaCargada: boolean;
  /** El último error al leer el cupo o la lista; cada lectura que sale bien borra el suyo. */
  errorCupo: unknown;
  errorLista: unknown;
  cargandoMas: boolean;
  errorMas: unknown;
  /** Por chofer: mientras hay una, los botones de esa fila no se ofrecen. */
  operaciones: Record<string, Operacion>;
  alta: Alta | null;
  /** El reporte de viajes y facturación del período elegido. */
  reporte: EstadoReporte;
  reiniciar(): void;
  /** Relee el cupo y la lista (las filas ya cargadas). Al abrir, con «Actualizar» y al volver a la pestaña. */
  refrescar(): Promise<void>;
  /** Relee el cupo. Las relecturas se juntan: una en vuelo y, como mucho, otra pendiente. Un error queda en `errorCupo`. */
  releerCupo(): Promise<void>;
  cargarMas(): Promise<void>;
  cambiarActivo(choferId: string, accion: Accion): void;
  /** Reintenta la operación incierta con la MISMA clave. */
  reintentar(choferId: string): void;
  cerrarOperacion(choferId: string): void;
  darDeAlta(datos: DatosAlta): void;
  reintentarAlta(): void;
  /** Abandona un alta incierta: cierra su clave y libera el formulario. */
  descartarAlta(): void;
  cerrarAlta(): void;
  /** Consulta el reporte de ese período. Solo se aplica la respuesta de la última consulta. */
  consultarReporte(periodo: Periodo): Promise<void>;
}

// Fuera del estado: no hace falta redibujar por ellos.
let marca = 0;
/** Un contador creciente: ordena las lecturas respecto de las respuestas de las mutaciones. */
const siguienteMarca = () => ++marca;
let generacion = 0;
let cupoEnVuelo = false;
let cupoPendiente = false;
/** Inicio de la última primera página aplicada: una recarga más vieja que llega tarde no la pisa. */
let primeraPaginaAplicada = 0;
/** La marca de cada consulta del reporte: un contador propio, aparte del de las mutaciones. */
let marcaReporte = 0;
const claves = new ClavesDeOperacion();

const sin = <T>(r: Record<string, T>, k: string) => {
  const { [k]: _, ...resto } = r;
  return resto;
};

const INICIAL = {
  ...LISTA_INICIAL,
  listaCargada: false,
  errorCupo: null,
  errorLista: null,
  cargandoMas: false,
  errorMas: null,
  operaciones: {},
  alta: null,
  reporte: REPORTE_INICIAL,
};

export const useFlota = create<StoreFlota>()((set, get) => {
  const objetivoOperacion = (id: string, accion: Accion) => `${accion}:${id}`;

  async function leerPagina(desde: number, limite: number): Promise<void> {
    const g = generacion;
    const inicio = siguienteMarca();
    const p = await pedir<PaginaChoferes>('GET', `/viajes/flota/choferes?limite=${limite}&desde=${desde}`);
    if (g !== generacion) return;
    if (desde === 0) {
      if (inicio < primeraPaginaAplicada) return;
      primeraPaginaAplicada = inicio;
    }
    set((e) => ({ ...aplicarPagina(e, p, { inicio, desde }), ...(desde === 0 ? { listaCargada: true, errorLista: null } : {}) }));
  }

  /** Relee una fila (después de un error definitivo, para mostrar cómo quedó). */
  async function releerChofer(id: string): Promise<void> {
    const g = generacion;
    const inicio = siguienteMarca();
    try {
      const c = await pedir<Chofer>('GET', `/viajes/flota/choferes/${id}`);
      if (g === generacion) set((e) => aplicarLecturaChofer(e, c, inicio));
    } catch {
      // Se ve en la próxima recarga.
    }
  }

  async function enviarOperacion(id: string): Promise<void> {
    const g = generacion;
    const op = get().operaciones[id];
    if (!op) return;
    const objetivo = objetivoOperacion(id, op.accion);
    try {
      const c = await pedir<Chofer>('POST', `/viajes/flota/choferes/${id}/${op.accion}`, { cuerpo: {}, clave: claves.para(objetivo) });
      if (g !== generacion) return;
      claves.cerrar(objetivo);
      set((e) => ({ ...aplicarChofer(e, c, siguienteMarca()), operaciones: sin(e.operaciones, id) }));
    } catch (err) {
      if (g !== generacion) return;
      if (!esIncierto(err)) {
        // Definitivo (409 por el límite o por la habilitación, 404): no se aplicó. La fila se relee.
        claves.cerrar(objetivo);
        set((e) => ({ operaciones: { ...e.operaciones, [id]: { ...op, fase: 'error', error: err } } }));
        void releerChofer(id);
      } else {
        set((e) => ({ operaciones: { ...e.operaciones, [id]: { ...op, fase: 'verificando', error: err } } }));
        await verificarOperacion(id, op.accion, err);
      }
    }
    // El cupo cambia con la operación (o con la de otro admin): la respuesta trae solo al chofer.
    void get().releerCupo();
  }

  /** Sin respuesta: la relectura del chofer dice si quedó como se pidió. Si no, la clave queda. */
  async function verificarOperacion(id: string, accion: Accion, errOriginal: unknown): Promise<void> {
    const g = generacion;
    const inicio = siguienteMarca();
    try {
      const c = await pedir<Chofer>('GET', `/viajes/flota/choferes/${id}`);
      if (g !== generacion) return;
      if (c.activo === (accion === 'activar')) {
        claves.cerrar(objetivoOperacion(id, accion));
        // Una mutación confirmada: lo leído antes de esta lectura ya no la pisa.
        set((e) => ({ ...aplicarChofer(e, c, inicio), operaciones: sin(e.operaciones, id) }));
        return;
      }
      set((e) => aplicarLecturaChofer(e, c, inicio));
    } catch {
      if (g !== generacion) return;
    }
    set((e) => ({ operaciones: { ...e.operaciones, [id]: { accion, fase: 'incierta', error: errOriginal } } }));
  }

  async function enviarAlta(): Promise<void> {
    const g = generacion;
    const a = get().alta;
    if (!a) return;
    const objetivo = objetivoAlta(a.datos);
    try {
      const c = await pedir<Chofer>('POST', '/viajes/flota/choferes', { cuerpo: a.datos, clave: claves.para(objetivo) });
      if (g !== generacion) return;
      claves.cerrar(objetivo);
      set((e) => ({ ...aplicarChofer(e, c, siguienteMarca()), alta: { ...a, fase: 'listo', error: null, real: c } }));
    } catch (err) {
      if (g !== generacion) return;
      if (!esIncierto(err)) {
        claves.cerrar(objetivo);
        set({ alta: { ...a, fase: 'error', error: err } });
        return;
      }
      set({ alta: { ...a, fase: 'verificando', error: err } });
      await verificarAlta(a.datos, err);
    }
  }

  /**
   * Sin respuesta al alta: un `GET` con 200 confirma que el chofer está en la flota. Es el alta pedida
   * solo si el vehículo coincide; si difiere, se muestra el real. Con 404 (o sin red) sigue incierta.
   */
  async function verificarAlta(datos: DatosAlta, errOriginal: unknown): Promise<void> {
    const g = generacion;
    const inicio = siguienteMarca();
    try {
      const c = await pedir<Chofer>('GET', `/viajes/flota/choferes/${datos.choferId}`);
      if (g !== generacion) return;
      // El estado se conoce: el chofer está en la flota. La clave ya no hace falta.
      claves.cerrar(objetivoAlta(datos));
      const fase = vehiculoCoincide(c, datos) ? 'listo' : 'difiere';
      set((e) => ({ ...aplicarChofer(e, c, inicio), alta: { datos, fase, error: null, real: c } }));
    } catch {
      if (g !== generacion) return;
      set({ alta: { datos, fase: 'incierta', error: errOriginal, real: null } });
    }
  }

  return {
    ...INICIAL,

    reiniciar() {
      generacion++;
      cupoEnVuelo = false;
      cupoPendiente = false;
      primeraPaginaAplicada = 0;
      set(INICIAL);
    },

    async refrescar() {
      const g = generacion;
      const lista = leerPagina(0, limiteRecarga(get().choferes.length)).catch((err: unknown) => {
        if (g === generacion) set({ errorLista: err });
      });
      const periodo = get().reporte.periodo;
      await Promise.all([get().releerCupo(), lista, periodo ? get().consultarReporte(periodo) : null]);
    },

    async consultarReporte(periodo) {
      const g = generacion;
      const marca = ++marcaReporte;
      set((e) => ({ reporte: pedirReporte(e.reporte, periodo, marca) }));
      const query = new URLSearchParams({ inicio: periodo.inicio, fin: periodo.fin });
      let resultado: { datos: Reporte } | { error: unknown };
      try {
        resultado = { datos: await pedir<Reporte>('GET', `/viajes/flota/reporte?${query.toString()}`) };
      } catch (err) {
        resultado = { error: err };
      }
      if (g === generacion) set((e) => ({ reporte: aplicarReporte(e.reporte, resultado, marca) }));
    },

    async releerCupo() {
      if (cupoEnVuelo) {
        cupoPendiente = true;
        return;
      }
      cupoEnVuelo = true;
      const g = generacion;
      try {
        do {
          cupoPendiente = false;
          const inicio = siguienteMarca();
          const f = await pedir<Flota>('GET', '/viajes/flota');
          if (g !== generacion) return;
          const { estado, descartada } = aplicarFlota(get(), f, inicio);
          set({ ...estado, errorCupo: null });
          // Empezó antes de la respuesta de una mutación: no sirve, se pide otra.
          if (descartada) cupoPendiente = true;
        } while (cupoPendiente);
      } catch (err) {
        if (g === generacion) set({ errorCupo: err });
      } finally {
        if (g === generacion) cupoEnVuelo = false;
      }
    },

    async cargarMas() {
      const { siguiente, cargandoMas } = get();
      if (siguiente === null || cargandoMas) return;
      const g = generacion;
      set({ cargandoMas: true, errorMas: null });
      try {
        await leerPagina(siguiente, PAGINA);
        if (g === generacion) set({ cargandoMas: false });
      } catch (err) {
        if (g === generacion) set({ cargandoMas: false, errorMas: err });
      }
    },

    cambiarActivo(choferId, accion) {
      const actual = get().operaciones[choferId];
      if (actual && actual.fase !== 'error') return;
      set((e) => ({ operaciones: { ...e.operaciones, [choferId]: { accion, fase: 'enviando', error: null } } }));
      void enviarOperacion(choferId);
    },

    reintentar(choferId) {
      const op = get().operaciones[choferId];
      if (!op || op.fase !== 'incierta') return;
      set((e) => ({ operaciones: { ...e.operaciones, [choferId]: { ...op, fase: 'enviando', error: null } } }));
      void enviarOperacion(choferId);
    },

    cerrarOperacion(choferId) {
      const op = get().operaciones[choferId];
      if (op?.fase === 'error') set((e) => ({ operaciones: sin(e.operaciones, choferId) }));
    },

    darDeAlta(datos) {
      const a = get().alta;
      if (a && (a.fase === 'enviando' || a.fase === 'verificando' || a.fase === 'incierta')) return;
      set({ alta: { datos: normalizarAlta(datos), fase: 'enviando', error: null, real: null } });
      void enviarAlta();
    },

    reintentarAlta() {
      const a = get().alta;
      if (!a || a.fase !== 'incierta') return;
      set({ alta: { ...a, fase: 'enviando', error: null } });
      void enviarAlta();
    },

    descartarAlta() {
      const a = get().alta;
      if (!a || a.fase !== 'incierta') return;
      claves.cerrar(objetivoAlta(a.datos));
      set({ alta: null });
    },

    cerrarAlta() {
      const a = get().alta;
      if (a && (a.fase === 'listo' || a.fase === 'difiere' || a.fase === 'error')) set({ alta: null });
    },
  };
});
