import { errorDeRed, errorDesdeRespuesta } from '../api/errores';
import { useSesion, type RespuestaSesion, type Usuario } from './store';

/**
 * `POST /api/identity/login`. Va por su cuenta y no por `pedir()`: acá un 401 significa credenciales
 * incorrectas (lo muestra el formulario), no un access token vencido que haya que renovar. No lleva
 * Idempotency-Key: el login no la exige.
 */
export async function entrar(email: string, contrasena: string): Promise<Usuario> {
  let res: Response;
  try {
    res = await fetch('/api/identity/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email, contrasena }),
    });
  } catch {
    throw errorDeRed();
  }
  if (!res.ok) throw await errorDesdeRespuesta(res);
  const sesion = (await res.json()) as RespuestaSesion;
  useSesion.getState().iniciar(sesion);
  return sesion.usuario;
}
