/**
 * Un error de la API, con el formato único de los servicios: `{ error: { code, message, requestId } }`.
 * `estado` 0 y código `RED`: no hubo respuesta (sin conexión, nginx caído).
 */
export class ErrorApi extends Error {
  constructor(
    readonly estado: number,
    readonly codigo: string,
    mensaje: string,
    readonly requestId: string | null = null,
    /** `Retry-After` en segundos, si vino (por ejemplo, con el límite de intentos de login). */
    readonly reintentarEnSegundos: number | null = null,
  ) {
    super(mensaje);
  }
}

export const errorDeRed = () => new ErrorApi(0, 'RED', 'No se pudo conectar con el servidor. Revisá tu conexión y volvé a intentar.');

/** Lee el error de una respuesta que no es 2xx. Si el cuerpo no tiene el formato, usa el estado. */
export async function errorDesdeRespuesta(res: Response): Promise<ErrorApi> {
  let cuerpo: unknown = null;
  try {
    cuerpo = await res.json();
  } catch {
    cuerpo = null;
  }
  const error = (cuerpo as { error?: { code?: unknown; message?: unknown; requestId?: unknown } } | null)?.error;
  const reintentar = Number(res.headers.get('retry-after'));
  return new ErrorApi(
    res.status,
    typeof error?.code === 'string' ? error.code : `HTTP_${res.status}`,
    typeof error?.message === 'string' ? error.message : `El servidor respondió ${res.status}`,
    typeof error?.requestId === 'string' ? error.requestId : res.headers.get('x-request-id'),
    Number.isFinite(reintentar) && reintentar > 0 ? reintentar : null,
  );
}
