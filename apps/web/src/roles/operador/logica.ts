import type { EstadoSolicitud } from '@viajes/contracts';
import { ErrorApi } from '../../api/errores';

// La lógica del panel del operador, sin React ni red.

export interface FiltroPanel {
  /** null: los viajes activos (lo que muestra el panel sin `estado`). */
  estado: EstadoSolicitud | null;
  /** Busca en el id del viaje, del pasajero y del chofer, y en el motivo de cancelación. */
  texto: string;
}

export const FILTRO_INICIAL: FiltroPanel = { estado: null, texto: '' };

export const POR_PAGINA = 20;

/** La ruta de `GET /panel/viajes` para el filtro y la página. */
export function rutaPanel(f: FiltroPanel, desde = 0): string {
  const q = new URLSearchParams({ limite: String(POR_PAGINA), desde: String(desde) });
  if (f.estado) q.set('estado', f.estado);
  const texto = f.texto.trim();
  if (texto) q.set('q', texto.slice(0, 100));
  return `/viajes/panel/viajes?${q}`;
}

/** El motivo que exige la API para que cancele un operador: de 3 a 200 caracteres. */
export function motivoValido(motivo: string): boolean {
  const m = motivo.trim();
  return m.length >= 3 && m.length <= 200;
}

/**
 * Los últimos 8 caracteres de un id: alcanzan para reconocerlo en la tabla (el completo va en el
 * title, y la búsqueda los encuentra). Los primeros no: los usuarios del seed empiezan todos igual.
 */
export const idCorto = (id: string) => id.slice(-8);

/** El texto de un rechazo definitivo al cancelar, o null si no es uno conocido. */
export function textoRechazoCancelacion(err: unknown): string | null {
  if (!(err instanceof ErrorApi)) return null;
  if (err.codigo === 'SOLICITUD_NO_CANCELABLE') return 'El viaje ya no se puede cancelar: terminó o ya estaba cancelado.';
  if (err.codigo === 'MOTIVO_REQUERIDO') return 'Escribí el motivo de la cancelación.';
  return null;
}
