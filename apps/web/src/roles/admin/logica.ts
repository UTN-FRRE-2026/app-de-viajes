import type { ChoferFlotaRespuesta } from '@viajes/contracts';
import { ErrorApi } from '../../api/errores';
import { textoDeError } from '../../componentes/MensajeError';
import { textoVehiculo } from '../flota/logica';

/**
 * Lógica pura de la habilitación de choferes del admin de la plataforma (sin React ni fetch), para
 * poder testearla. La API no lista choferes para el admin: se trabaja con el código del chofer (su
 * UUID), el mismo que usó el admin de flota para darlo de alta.
 */

export type Chofer = ChoferFlotaRespuesta;
export type Accion = 'habilitar' | 'deshabilitar';

/** Cuántos choferes recientes se muestran debajo del formulario. */
export const RECIENTES_MAX = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Como lo espera la API: sin espacios y en minúsculas (al copiarlo se cuelan espacios). */
export const normalizarCodigo = (texto: string) => texto.replace(/\s+/g, '').toLowerCase();

/** Validación liviana antes de enviar; la que vale es la de la API. */
export function errorCodigo(texto: string): string | null {
  const c = normalizarCodigo(texto);
  if (c === '') return 'Pegá el código del chofer.';
  return UUID.test(c) ? null : 'El código del chofer es un UUID, como 426e8d80-6da8-4dbc-9480-c8d39f9a9c37.';
}

/** El objetivo de la Idempotency-Key: una por chofer y acción. */
export const objetivoHabilitacion = (choferId: string, accion: Accion) => `${accion}:${choferId}`;

const TEXTOS: Record<string, string> = {
  CHOFER_NO_ENCONTRADO: 'Ese chofer no está en ninguna flota: primero lo tiene que dar de alta el admin de su flota.',
};

/** El texto de un error de la pantalla, con los códigos de la habilitación traducidos. */
export function textoErrorHabilitacion(err: unknown): string {
  if (err instanceof ErrorApi) {
    const t = TEXTOS[err.codigo];
    if (t) return t;
  }
  return textoDeError(err);
}

/** Lo que pasó, en una línea, después de una respuesta 200. */
export function textoHecho(accion: Accion, c: Chofer): string {
  const v = textoVehiculo(c.vehiculo);
  return accion === 'habilitar'
    ? `Habilitado: ${v}. Ya lo puede activar el admin de su flota.`
    : `Deshabilitado: ${v}. Quedó inactivo y no recibe viajes hasta que lo vuelvas a habilitar.`;
}

/** El chofer que devolvió la API, primero en la lista de recientes (sin repetirlo y con tope). */
export function agregarReciente(recientes: readonly Chofer[], c: Chofer): Chofer[] {
  return [c, ...recientes.filter((x) => x.id !== c.id)].slice(0, RECIENTES_MAX);
}
