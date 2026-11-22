import { useSesion, type RespuestaSesion } from '../sesion/store';
import { ErrorApi, errorDeRed, errorDesdeRespuesta } from './errores';

/** La renovación en curso, compartida: si llegan varios 401 a la vez, se hace un solo refresh. */
let renovacionEnCurso: Promise<string | null> | null = null;

/**
 * Pide un access token nuevo con el refresh guardado y devuelve el token, o null si no hay sesión
 * que renovar.
 * - **Una sola a la vez:** identity rota el refresh en cada uso y, si ve uno ya usado, revoca la
 *   sesión entera; dos renovaciones simultáneas con el mismo refresh la cerrarían.
 * - **No se reintenta:** si el refresh no es válido, la sesión termina; si falla la red, el error
 *   sube a quien llamó.
 * - **Se descarta si llega tarde:** si mientras tanto se cerró la sesión (o empezó otra), la
 *   respuesta no se aplica.
 */
export function renovarAcceso(): Promise<string | null> {
  if (renovacionEnCurso) return renovacionEnCurso;
  const { refreshToken, epoca } = useSesion.getState();
  if (!refreshToken) return Promise.resolve(null);
  const vigente = () => useSesion.getState().epoca === epoca;

  renovacionEnCurso = (async () => {
    let res: Response;
    try {
      res = await fetch('/api/identity/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      throw errorDeRed();
    }
    if (!vigente()) return null;
    if (!res.ok) {
      // Refresh vencido, revocado o reusado: no hay nada que reintentar.
      useSesion.getState().cerrar();
      return null;
    }
    const sesion = (await res.json()) as RespuestaSesion;
    if (!vigente()) return null;
    useSesion.getState().renovada(sesion);
    return sesion.token;
  })().finally(() => {
    renovacionEnCurso = null;
  });
  return renovacionEnCurso;
}

/**
 * Al abrir la página: si quedó un refresh guardado, recupera la sesión antes de que las rutas
 * protegidas decidan (mientras tanto el estado es `cargando` y nadie redirige).
 */
export async function recuperarSesion(): Promise<void> {
  if (!useSesion.getState().refreshToken) {
    useSesion.setState({ estado: 'anonima' });
    return;
  }
  try {
    const token = await renovarAcceso();
    if (!token && useSesion.getState().estado === 'cargando') useSesion.getState().cerrar();
  } catch {
    // Sin red al abrir: se empieza sin sesión; el usuario vuelve a entrar.
    useSesion.getState().cerrar();
  }
}

export interface OpcionesPedido {
  cuerpo?: unknown;
  /**
   * `Idempotency-Key` de la OPERACIÓN (las rutas que la exigen: los POST y PUT con efecto de
   * dispatch y `POST /identity/registro`). Se genera una vez por acción del usuario y se reutiliza
   * tal cual en cualquier reintento, incluido el que sigue a renovar el access token.
   */
  clave?: string;
}

/** Una clave nueva para una operación con efecto. */
export const nuevaClave = () => crypto.randomUUID();

/**
 * Pedido a la API por la ruta relativa `/api/...` (nginx, o el proxy de Vite en desarrollo).
 * `ruta` empieza por el servicio: `/viajes/solicitudes`, `/identity/logout`.
 *
 * Con un 401 se intenta **una sola vez** más, con la misma clave:
 * - si mientras este pedido viajaba otro ya renovó el access, con el token vigente;
 * - si no, renovando (compartido con los demás pedidos que estén esperando).
 * Si igual da 401, la sesión termina y el error sube.
 */
export async function pedir<T>(metodo: string, ruta: string, { cuerpo, clave }: OpcionesPedido = {}): Promise<T> {
  const enviar = async (token: string | null) => {
    const encabezados: Record<string, string> = { accept: 'application/json' };
    if (token) encabezados.authorization = `Bearer ${token}`;
    if (cuerpo !== undefined) encabezados['content-type'] = 'application/json';
    if (clave) encabezados['idempotency-key'] = clave;
    try {
      return await fetch(`/api${ruta}`, {
        method: metodo,
        headers: encabezados,
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      });
    } catch {
      throw errorDeRed();
    }
  };

  const tokenUsado = useSesion.getState().token;
  let res = await enviar(tokenUsado);
  if (res.status === 401 && tokenUsado) {
    const actual = useSesion.getState().token;
    const otro = actual && actual !== tokenUsado ? actual : await renovarAcceso();
    if (otro) res = await enviar(otro);
    if (res.status === 401) useSesion.getState().cerrar();
  }
  if (!res.ok) throw await errorDesdeRespuesta(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Cierra la sesión: primero localmente (así se descarta cualquier refresh en vuelo), después en identity. */
export async function cerrarSesion(): Promise<void> {
  const { refreshToken } = useSesion.getState();
  useSesion.getState().cerrar();
  if (!refreshToken) return;
  // keepalive: el aviso llega aunque la página navegue o se cierre enseguida. Si falla, el refresh
  // igual vence solo; el usuario ya no tiene sesión en este navegador.
  await fetch('/api/identity/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    keepalive: true,
  }).catch(() => undefined);
}

export { ErrorApi };
