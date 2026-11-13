import { z } from 'zod';

// El identificador de acceso es el email, siempre en minúsculas y sin espacios alrededor.
const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));

// El máximo acota el trabajo de argon2 frente a contraseñas enormes.
export const CONTRASENA_MIN = 12;
export const CONTRASENA_MAX = 128;

/** Solo estos roles se pueden crear por el registro público. */
export const RolRegistrable = z.enum(['pasajero', 'chofer']);

export const RegistroBody = z.strictObject({
  email: Email,
  contrasena: z.string().min(CONTRASENA_MIN).max(CONTRASENA_MAX),
  nombre: z.string().trim().min(1).max(100),
  rol: RolRegistrable,
});
export type RegistroBody = z.infer<typeof RegistroBody>;

// En el login no se exige el mínimo: una contraseña corta es simplemente incorrecta.
export const LoginBody = z.strictObject({
  email: Email,
  contrasena: z.string().min(1).max(CONTRASENA_MAX),
});
export type LoginBody = z.infer<typeof LoginBody>;

// Opaco, no es un JWT: identity lo busca por su SHA-256. El máximo solo acota el body.
export const RefreshBody = z.strictObject({
  refreshToken: z.string().min(1).max(256),
});
export type RefreshBody = z.infer<typeof RefreshBody>;
