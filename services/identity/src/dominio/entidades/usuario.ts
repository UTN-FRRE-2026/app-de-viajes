import { RolNoRegistrable } from '../errores/index.js';

export type Rol = 'pasajero' | 'chofer' | 'operador' | 'admin' | 'admin_flota';

const ROLES_REGISTRABLES: readonly string[] = ['pasajero', 'chofer'];

export interface DatosUsuario {
  id: string;
  email: string;
  hashContrasena: string;
  nombre: string;
  rol: Rol;
  /** Solo para `admin_flota`. */
  fleetId: string | null;
  creadoEn: Date;
}

/** Lo que se puede devolver afuera: nunca incluye el hash. */
export interface UsuarioPublico {
  id: string;
  email: string;
  nombre: string;
  rol: Rol;
  fleetId?: string;
  creadoEn: Date;
}

export function normalizarEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Segunda barrera contra la elevación de privilegios, independiente del esquema HTTP:
 * aunque otro adaptador llame al caso de uso, el registro público no crea roles privilegiados.
 */
export function exigirRolRegistrable(rol: string): asserts rol is 'pasajero' | 'chofer' {
  if (!ROLES_REGISTRABLES.includes(rol)) throw new RolNoRegistrable();
}

export class Usuario {
  private constructor(private readonly datos: DatosUsuario) {}

  static registrar(entrada: Omit<DatosUsuario, 'rol' | 'fleetId'> & { rol: string }): Usuario {
    const { rol } = entrada;
    exigirRolRegistrable(rol);
    return new Usuario({ ...entrada, email: normalizarEmail(entrada.email), rol, fleetId: null });
  }

  static reconstruir(datos: DatosUsuario): Usuario {
    return new Usuario({ ...datos });
  }

  get id() {
    return this.datos.id;
  }
  get email() {
    return this.datos.email;
  }
  get hashContrasena() {
    return this.datos.hashContrasena;
  }
  get rol() {
    return this.datos.rol;
  }
  get fleetId() {
    return this.datos.fleetId;
  }

  aDatos(): DatosUsuario {
    return { ...this.datos };
  }

  aPublico(): UsuarioPublico {
    const { id, email, nombre, rol, fleetId, creadoEn } = this.datos;
    return { id, email, nombre, rol, ...(fleetId ? { fleetId } : {}), creadoEn };
  }
}
