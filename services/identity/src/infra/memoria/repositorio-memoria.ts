import { Usuario, type DatosUsuario } from '../../dominio/entidades/index.js';
import type {
  RefreshGuardado,
  RepositorioSesiones,
  RepositorioUsuarios,
  ResultadoRotacion,
} from '../../dominio/puertos/index.js';

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

  async buscarPorId(id: string): Promise<Usuario | null> {
    const datos = [...this.usuarios.values()].find((u) => u.id === id);
    return datos ? Usuario.reconstruir(datos) : null;
  }
}

export interface RefreshEnMemoria extends RefreshGuardado {
  usadoEn: Date | null;
  revocadoEn: Date | null;
}

/** Sin `await` entre leer y marcar: en un solo hilo, `rotar` es atómico igual que el UPDATE de Postgres. */
export class RepositorioSesionesMemoria implements RepositorioSesiones {
  readonly tokens = new Map<string, RefreshEnMemoria>();

  async crear(refresh: RefreshGuardado): Promise<void> {
    this.tokens.set(refresh.huella, { ...refresh, usadoEn: null, revocadoEn: null });
  }

  async rotar(
    huellaActual: string,
    nuevo: Pick<RefreshGuardado, 'huella' | 'creadoEn' | 'expiraEn'>,
  ): Promise<ResultadoRotacion> {
    const actual = this.tokens.get(huellaActual);
    if (!actual) return { resultado: 'invalido' };
    if (actual.usadoEn) return { resultado: 'reusado', familiaId: actual.familiaId };
    if (actual.revocadoEn || actual.expiraEn <= nuevo.creadoEn) return { resultado: 'invalido' };

    actual.usadoEn = nuevo.creadoEn;
    this.tokens.set(nuevo.huella, {
      ...nuevo,
      usuarioId: actual.usuarioId,
      familiaId: actual.familiaId,
      usadoEn: null,
      revocadoEn: null,
    });
    return { resultado: 'rotado', usuarioId: actual.usuarioId };
  }

  async revocarFamilia(familiaId: string, ahora: Date): Promise<void> {
    for (const token of this.tokens.values()) {
      if (token.familiaId === familiaId && !token.revocadoEn) token.revocadoEn = ahora;
    }
  }
}
