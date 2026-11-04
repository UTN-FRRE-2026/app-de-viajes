import { Usuario, type Rol } from '../../dominio/entidades/index.js';
import type { RepositorioUsuarios } from '../../dominio/puertos/index.js';
import type { PrismaClient } from './generated/client.js';

export class RepositorioUsuariosPrisma implements RepositorioUsuarios {
  constructor(private readonly prisma: PrismaClient) {}

  async insertar(usuario: Usuario): Promise<boolean> {
    // ON CONFLICT DO NOTHING: si dos pedidos llegan juntos con el mismo email, el índice único
    // decide. Un "buscar y después insertar" dejaría pasar a los dos.
    const { count } = await this.prisma.usuario.createMany({ data: [usuario.aDatos()], skipDuplicates: true });
    return count === 1;
  }

  async buscarPorEmail(email: string): Promise<Usuario | null> {
    const fila = await this.prisma.usuario.findUnique({ where: { email } });
    return fila ? Usuario.reconstruir({ ...fila, rol: fila.rol as Rol }) : null;
  }
}
