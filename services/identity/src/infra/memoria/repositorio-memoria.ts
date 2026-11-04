import { Usuario, type DatosUsuario } from '../../dominio/entidades/index.js';
import type { RepositorioUsuarios } from '../../dominio/puertos/index.js';

/** Adaptador en memoria: el Map por email hace de restricción única. */
export class RepositorioUsuariosMemoria implements RepositorioUsuarios {
  readonly usuarios = new Map<string, DatosUsuario>();

  async insertar(usuario: Usuario): Promise<boolean> {
    if (this.usuarios.has(usuario.email)) return false;
    this.usuarios.set(usuario.email, usuario.aDatos());
    return true;
  }

  async buscarPorEmail(email: string): Promise<Usuario | null> {
    const datos = this.usuarios.get(email);
    return datos ? Usuario.reconstruir(datos) : null;
  }
}
