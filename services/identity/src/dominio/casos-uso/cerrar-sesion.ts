import type { DependenciasIdentidad } from './dependencias.js';

/**
 * Logout: revoca la familia del refresh token recibido, es decir, la sesión de ese dispositivo.
 * Las demás sesiones del usuario son otras familias y siguen funcionando.
 *
 * - Sirve cualquier token de la familia, aunque esté usado, vencido o revocado: con uno viejo,
 *   `/refresh` ya revocaría todo por reuso, así que no se abre ningún ataque nuevo.
 * - Un token desconocido no es un error: el logout es idempotente y no revela qué tokens existen.
 * - El access token ya emitido no se toca: sigue valiendo hasta su `exp` (JWT_TTL_SEGUNDOS).
 * - Si la revocación falla (por ejemplo, se cae Postgres), el error sube: el cliente no recibe
 *   un 204 de una sesión que sigue abierta.
 */
export function cerrarSesion(deps: DependenciasIdentidad) {
  return async (refreshToken: string): Promise<void> => {
    const familiaId = await deps.sesiones.familiaDe(deps.refresh.huella(refreshToken));
    if (!familiaId) return;
    // Mismo camino que la detección de reuso: el lock por familia también cubre una renovación
    // simultánea, y su token nuevo queda revocado.
    await deps.sesiones.revocarFamilia(familiaId, deps.reloj.ahora());
  };
}
