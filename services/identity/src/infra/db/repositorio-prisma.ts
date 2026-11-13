import { Usuario, type Rol } from '../../dominio/entidades/index.js';
import type {
  RefreshGuardado,
  RepositorioSesiones,
  RepositorioUsuarios,
  ResultadoRotacion,
} from '../../dominio/puertos/index.js';
import type { PrismaClient } from './generated/client.js';

type FilaUsuario = NonNullable<Awaited<ReturnType<PrismaClient['usuario']['findUnique']>>>;

const aUsuario = (fila: FilaUsuario) => Usuario.reconstruir({ ...fila, rol: fila.rol as Rol });

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
    return fila ? aUsuario(fila) : null;
  }

  async buscarPorId(id: string): Promise<Usuario | null> {
    const fila = await this.prisma.usuario.findUnique({ where: { id } });
    return fila ? aUsuario(fila) : null;
  }
}

/**
 * Lock por familia, hasta el fin de la transacción. Lo toman la rotación y la revocación, así
 * nunca corren a la vez sobre la misma sesión. Los locks de fila no alcanzan: una revocación que
 * espera la fila del token en rotación no ve, al seguir, el token que esa rotación acaba de crear.
 */
const bloquearFamilia = (tx: Pick<PrismaClient, '$executeRaw'>, familiaId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${familiaId}, 0))`;

export class RepositorioSesionesPrisma implements RepositorioSesiones {
  constructor(private readonly prisma: PrismaClient) {}

  async crear(refresh: RefreshGuardado): Promise<void> {
    await this.prisma.refreshToken.create({ data: refresh });
  }

  rotar(
    huellaActual: string,
    nuevo: Pick<RefreshGuardado, 'huella' | 'creadoEn' | 'expiraEn'>,
  ): Promise<ResultadoRotacion> {
    return this.prisma.$transaction(async (tx) => {
      const previo = await tx.refreshToken.findUnique({ where: { huella: huellaActual }, select: { familiaId: true } });
      if (!previo) return { resultado: 'invalido' };
      // Orden fijo: primero la familia, después la fila del token.
      await bloquearFamilia(tx, previo.familiaId);
      // UPDATE condicional y no "leer y después marcar": con dos pedidos simultáneos, el segundo
      // espera el lock de la fila, vuelve a evaluar el WHERE con used_at ya cargado y no actualiza nada.
      const { count } = await tx.refreshToken.updateMany({
        where: { huella: huellaActual, usadoEn: null, revocadoEn: null, expiraEn: { gt: nuevo.creadoEn } },
        data: { usadoEn: nuevo.creadoEn },
      });
      const actual = await tx.refreshToken.findUnique({ where: { huella: huellaActual } });
      if (!actual) return { resultado: 'invalido' };
      if (count === 0) {
        // Usado cuenta como reuso aunque además esté vencido o revocado.
        return actual.usadoEn ? { resultado: 'reusado', familiaId: actual.familiaId } : { resultado: 'invalido' };
      }
      await tx.refreshToken.create({
        data: { ...nuevo, usuarioId: actual.usuarioId, familiaId: actual.familiaId },
      });
      return { resultado: 'rotado', usuarioId: actual.usuarioId };
    });
  }

  async revocarFamilia(familiaId: string, ahora: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Con el lock tomado, el UPDATE ve todo lo que confirmaron las rotaciones anteriores.
      await bloquearFamilia(tx, familiaId);
      await tx.refreshToken.updateMany({ where: { familiaId, revocadoEn: null }, data: { revocadoEn: ahora } });
    });
  }
}
