import { RefreshInvalido } from '../errores/index.js';
import type { DependenciasIdentidad } from './dependencias.js';
import { armarSesion, vencimientoRefresh, type Sesion } from './sesion.js';

/**
 * Rotación: cada refresh token sirve una sola vez y se cambia por uno nuevo de la misma familia.
 * Si llega uno ya usado, alguien tiene una copia (el dueño o el ladrón, no se sabe cuál):
 * se revoca la familia entera y los dos tienen que volver a hacer login.
 */
export function renovarSesion(deps: DependenciasIdentidad) {
  return async (refreshToken: string): Promise<Sesion> => {
    const ahora = deps.reloj.ahora();
    const nuevo = deps.refresh.nuevo();
    const rotacion = await deps.sesiones.rotar(deps.refresh.huella(refreshToken), {
      huella: nuevo.huella,
      creadoEn: ahora,
      expiraEn: vencimientoRefresh(deps, ahora),
    });

    if (rotacion.resultado === 'reusado') {
      await deps.sesiones.revocarFamilia(rotacion.familiaId, ahora);
      throw new RefreshInvalido();
    }
    if (rotacion.resultado === 'invalido') throw new RefreshInvalido();

    // Si el usuario se borró, la FK ya borró sus tokens; esto cubre la carrera con ese borrado.
    const usuario = await deps.repo.buscarPorId(rotacion.usuarioId);
    if (!usuario) throw new RefreshInvalido();
    return armarSesion(deps, usuario, nuevo);
  };
}
