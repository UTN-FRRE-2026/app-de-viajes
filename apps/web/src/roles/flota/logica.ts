import type { ChoferFlotaRespuesta, FlotaRespuesta, Vehiculo } from '@viajes/contracts';
import { ErrorApi } from '../../api/errores';
import { textoDeError } from '../../componentes/MensajeError';

/**
 * Lógica pura del panel de la flota (sin React ni fetch), para poder testearla.
 *
 * Lecturas atrasadas, la misma regla que en /chofer: cada lectura guarda la marca con la que empezó
 * y cada respuesta de una mutación guarda la suya, del mismo contador creciente.
 * - El cupo (`GET /flota`): una lectura que empezó antes de la última mutación se descarta entera.
 * - Las filas: una página (o el `GET` de un chofer) que empezó antes de la última mutación de ESA
 *   fila no la pisa; las demás filas de la página sí se aplican.
 */

export type Chofer = ChoferFlotaRespuesta;
export type Flota = FlotaRespuesta;

/** Tamaño de página de la lista (`GET /flota/choferes?limite`). */
export const PAGINA = 10;
/** El máximo que acepta la API por página (`LIMITE_LISTADO_MAX`). */
export const PAGINA_MAX = 50;

export interface PaginaChoferes {
  choferes: Chofer[];
  siguiente: number | null;
}

export interface EstadoLista {
  flota: Flota | null;
  /** Marca de la última mutación de cualquier chofer: el cupo leído antes no sirve. */
  ultimaMutacion: number;
  /** En el orden de la API: el de alta. */
  choferes: Chofer[];
  /** Marca de la última mutación de cada chofer. */
  mutados: Record<string, number>;
  /** `desde` de la próxima página, o null si no hay más. */
  siguiente: number | null;
}

export const LISTA_INICIAL: EstadoLista = { flota: null, ultimaMutacion: 0, choferes: [], mutados: {}, siguiente: null };

/** El cupo leído. `descartada`: empezó antes de la última mutación y hay que pedir otro. */
export function aplicarFlota(e: EstadoLista, flota: Flota, inicio: number): { estado: EstadoLista; descartada: boolean } {
  if (inicio < e.ultimaMutacion) return { estado: e, descartada: true };
  return { estado: { ...e, flota }, descartada: false };
}

/**
 * Una página leída. `desde === 0` reemplaza la lista (es una recarga); si no, agrega al final.
 * Una fila mutada después de que empezó la lectura queda como está, y un chofer dado de alta
 * mientras tanto (que la página todavía no trae) no se pierde.
 */
export function aplicarPagina(e: EstadoLista, p: PaginaChoferes, { inicio, desde }: { inicio: number; desde: number }): EstadoLista {
  const fresco = (c: Chofer) => ((e.mutados[c.id] ?? 0) > inicio ? (e.choferes.find((x) => x.id === c.id) ?? c) : c);
  const leidos = p.choferes.map(fresco);
  const ids = new Set(leidos.map((c) => c.id));
  let choferes: Chofer[];
  if (desde === 0) {
    const recientes = e.choferes.filter((c) => !ids.has(c.id) && (e.mutados[c.id] ?? 0) > inicio);
    choferes = [...leidos, ...recientes];
  } else {
    const previos = e.choferes.filter((c) => !ids.has(c.id));
    choferes = [...previos, ...leidos];
  }
  return { ...e, choferes, siguiente: p.siguiente };
}

/** El chofer que devolvió una mutación (o una lectura que la confirma): gana sobre lo leído antes de `marca`. */
export function aplicarChofer(e: EstadoLista, c: Chofer, marca: number, { agregarAlFinal = true } = {}): EstadoLista {
  const existe = e.choferes.some((x) => x.id === c.id);
  // Un alta va al final (el orden de la API es el de alta). Si quedan páginas sin leer, aparece al llegar a ella.
  const choferes = existe
    ? e.choferes.map((x) => (x.id === c.id ? c : x))
    : agregarAlFinal && e.siguiente === null
      ? [...e.choferes, c]
      : e.choferes;
  return { ...e, choferes, mutados: { ...e.mutados, [c.id]: marca }, ultimaMutacion: Math.max(e.ultimaMutacion, marca) };
}

/** El `GET` de un chofer: no pisa una mutación de esa fila posterior a su inicio. */
export function aplicarLecturaChofer(e: EstadoLista, c: Chofer, inicio: number): EstadoLista {
  if ((e.mutados[c.id] ?? 0) > inicio) return e;
  if (!e.choferes.some((x) => x.id === c.id)) return e;
  return { ...e, choferes: e.choferes.map((x) => (x.id === c.id ? c : x)) };
}

/** Cuántas filas pedir al recargar: las que ya están cargadas, así «Actualizar» no achica la lista. */
export function limiteRecarga(cargados: number): number {
  return Math.min(PAGINA_MAX, Math.max(PAGINA, Math.ceil(cargados / PAGINA) * PAGINA));
}

export const enLimite = (f: Flota | null) => f !== null && f.activos >= f.maxActivos;

export const textoLimite = (f: Flota | null) =>
  f
    ? `La flota llegó a su límite de ${f.maxActivos} ${f.maxActivos === 1 ? 'chofer activo' : 'choferes activos'}. Para activar a otro, desactivá uno: así se libera un cupo.`
    : 'La flota llegó a su límite de choferes activos. Para activar a otro, desactivá uno: así se libera un cupo.';

export const PENDIENTE_HABILITACION = 'Pendiente de habilitación por el admin de la plataforma: hasta entonces no se puede activar.';

/** Por qué no se puede activar a este chofer desde el panel, o null si se puede. */
export function motivoSinActivar(c: Chofer): string | null {
  return c.habilitado ? null : PENDIENTE_HABILITACION;
}

const TEXTOS: Record<string, string> = {
  CHOFER_NO_HABILITADO: PENDIENTE_HABILITACION,
  CHOFER_YA_REGISTRADO: 'Ese chofer ya está en una flota.',
  PATENTE_YA_REGISTRADA: 'Esa patente ya está registrada.',
  CUENTA_NO_ES_CHOFER: 'Ese código no es de una cuenta de chofer.',
  IDENTITY_NO_DISPONIBLE: 'No se pudo verificar la cuenta del chofer en este momento.',
  CHOFER_NO_ENCONTRADO: 'Ese chofer no está en tu flota.',
  FLOTA_NO_ENCONTRADA: 'Tu flota todavía no está creada en la plataforma: pedile al admin que la cree.',
  FLOTA_NO_ASIGNADA: 'Tu usuario no tiene una flota asignada.',
};

/** El texto de un error del panel, con los códigos de flotas traducidos. */
export function textoErrorFlota(err: unknown, flota: Flota | null): string {
  if (err instanceof ErrorApi) {
    if (err.codigo === 'LIMITE_FLOTA_ALCANZADO') return textoLimite(flota);
    const t = TEXTOS[err.codigo];
    if (t) return t;
  }
  return textoDeError(err);
}

// --- Alta ---

export interface DatosAlta {
  choferId: string;
  vehiculo: Vehiculo;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** La misma regla que `Patente` de contracts (sin traer zod al bundle). */
const PATENTE = /^(?:[A-Z]{3}\d{3}|[A-Z]{2}\d{3}[A-Z]{2})$/;

/** Como lo guarda la API: patente en mayúsculas y sin espacios; marca y modelo sin espacios a los lados. */
export function normalizarAlta(d: DatosAlta): DatosAlta {
  return {
    choferId: d.choferId.trim().toLowerCase(),
    vehiculo: {
      patente: d.vehiculo.patente.replace(/\s+/g, '').toUpperCase(),
      marca: d.vehiculo.marca.trim(),
      modelo: d.vehiculo.modelo.trim(),
    },
  };
}

/** Validación liviana antes de enviar; la que vale es la de la API. */
export function erroresAlta(d: DatosAlta): Partial<Record<'choferId' | 'patente' | 'marca' | 'modelo', string>> {
  const n = normalizarAlta(d);
  const e: Partial<Record<'choferId' | 'patente' | 'marca' | 'modelo', string>> = {};
  if (!UUID.test(n.choferId)) e.choferId = 'El código del chofer es un UUID (lo ve el chofer en su pantalla).';
  if (!PATENTE.test(n.vehiculo.patente)) e.patente = 'Patente inválida: ABC123 o AB123CD.';
  if (n.vehiculo.marca.length < 1 || n.vehiculo.marca.length > 40) e.marca = 'Entre 1 y 40 caracteres.';
  if (n.vehiculo.modelo.length < 1 || n.vehiculo.modelo.length > 40) e.modelo = 'Entre 1 y 40 caracteres.';
  return e;
}

/** El objetivo de la clave: el cuerpo entero, porque con la misma clave y otro cuerpo la API da 422. */
export const objetivoAlta = (d: DatosAlta) => `alta:${JSON.stringify(normalizarAlta(d))}`;

/** true si el chofer leído tiene el vehículo que se envió en el alta. */
export function vehiculoCoincide(c: Chofer, d: DatosAlta): boolean {
  const n = normalizarAlta(d).vehiculo;
  return c.vehiculo.patente === n.patente && c.vehiculo.marca === n.marca && c.vehiculo.modelo === n.modelo;
}

export const textoVehiculo = (v: Vehiculo) => `${v.marca} ${v.modelo} (${v.patente})`;
