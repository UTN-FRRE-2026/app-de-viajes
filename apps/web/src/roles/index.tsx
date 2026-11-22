import type { Rol } from '@viajes/contracts';
import type { RouteObject } from 'react-router';
import { chofer } from './chofer';
import { flota } from './flota';
import { operador } from './operador';
import { pasajero } from './pasajero';

/**
 * Lo que aporta cada rol al frontend. Para sumar una pantalla de un rol:
 * 1. el componente, en `src/roles/<rol>/`;
 * 2. una entrada en `rutas` (relativa a `base`) y, si va en el menú, otra en `menu`, en el archivo
 *    del rol (`src/roles/<rol>.tsx`);
 * 3. sus llamadas con `pedir()`, pasando `clave` (de `nuevaClave()`) si la ruta exige Idempotency-Key,
 *    y reutilizándola en cada reintento de esa operación.
 * Nada más cambia: el router monta cada módulo bajo su `base`, protegido por sus `roles`.
 */
export interface ModuloRol {
  /** Los roles que pueden entrar. Otro rol que llegue por URL ve «no es para tu rol». */
  roles: readonly Rol[];
  /** Ruta base, también el inicio del rol después del login. */
  base: string;
  titulo: string;
  menu: readonly { ruta: string; texto: string }[];
  rutas: RouteObject[];
}

export const MODULOS: readonly ModuloRol[] = [pasajero, chofer, operador, flota];

/** El módulo de un rol (cada rol está en uno solo). */
export function moduloDe(rol: Rol): ModuloRol {
  const modulo = MODULOS.find((m) => m.roles.includes(rol));
  if (!modulo) throw new Error(`rol sin pantallas: ${rol}`);
  return modulo;
}
