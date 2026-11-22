import type { Rol } from '@viajes/contracts';
import { Navigate, Outlet, useLocation } from 'react-router';
import { moduloDe } from '../roles';
import { NoPermitido } from '../pantallas/NoPermitido';
import { useSesion } from './store';

/**
 * Las rutas protegidas. Mientras se recupera la sesión guardada (`cargando`) no decide nada: así una
 * recarga no manda al login a alguien que tenía sesión. Sin sesión, al login con la ruta de vuelta.
 */
export function RequiereSesion() {
  const estado = useSesion((s) => s.estado);
  const ubicacion = useLocation();
  if (estado === 'cargando') return <p className="cargando">Cargando la sesión…</p>;
  if (estado === 'anonima') {
    const volver = `${ubicacion.pathname}${ubicacion.search}`;
    return <Navigate to={`/login?volver=${encodeURIComponent(volver)}`} replace />;
  }
  return <Outlet />;
}

/**
 * Una sección de un rol. Otro rol que entra por la URL ve «no es para tu rol». Es solo para la
 * interfaz: quien autoriza de verdad es la API.
 */
export function RequiereRol({ roles }: { roles: readonly Rol[] }) {
  const rol = useSesion((s) => s.usuario?.rol);
  if (!rol || !roles.includes(rol)) return <NoPermitido />;
  return <Outlet />;
}

/** `/`: al inicio del rol. */
export function IrAlInicio() {
  const rol = useSesion((s) => s.usuario?.rol);
  return rol ? <Navigate to={moduloDe(rol).base} replace /> : null;
}
