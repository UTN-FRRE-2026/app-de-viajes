import { describe, expect, it } from 'vitest';
import { RefreshInvalido } from '../../src/dominio/errores/index.js';
import { CONTRASENA, sistemaEnMemoria } from '../soporte/memoria.js';

const credenciales = { email: 'ana@viajes.test', contrasena: CONTRASENA };

/** Un usuario con dos sesiones abiertas, como si entrara desde dos dispositivos. */
async function conDosSesiones() {
  const s = sistemaEnMemoria();
  await s.casos.registrarUsuario({ ...credenciales, nombre: 'Ana', rol: 'pasajero' });
  const a = await s.casos.iniciarSesion(credenciales);
  const b = await s.casos.iniciarSesion(credenciales);
  return { ...s, a, b };
}

const familiaDe = (s: Awaited<ReturnType<typeof conDosSesiones>>, token: string) =>
  s.sesiones.tokens.get(`huella:${token}`)?.familiaId;

describe('cerrar sesión', () => {
  it('después del logout, ese refresh ya no renueva', async () => {
    const s = await conDosSesiones();
    await s.casos.cerrarSesion(s.a.refreshToken);
    await expect(s.casos.renovarSesion(s.a.refreshToken)).rejects.toBeInstanceOf(RefreshInvalido);
  });

  it('la otra sesión del mismo usuario sigue renovando', async () => {
    const s = await conDosSesiones();
    await s.casos.cerrarSesion(s.a.refreshToken);
    await expect(s.casos.renovarSesion(s.b.refreshToken)).resolves.toMatchObject({ refreshToken: expect.any(String) });
  });

  it('revoca todos los tokens de esa familia y ninguno de la otra', async () => {
    const s = await conDosSesiones();
    const renovada = await s.casos.renovarSesion(s.a.refreshToken);
    await s.casos.cerrarSesion(renovada.refreshToken);

    const familiaA = familiaDe(s, s.a.refreshToken);
    const tokens = [...s.sesiones.tokens.values()];
    expect(tokens.filter((t) => t.familiaId === familiaA).every((t) => t.revocadoEn)).toBe(true);
    expect(tokens.filter((t) => t.familiaId !== familiaA).every((t) => !t.revocadoEn)).toBe(true);
  });

  it('con un token ya rotado también cierra la sesión vigente de esa familia', async () => {
    const s = await conDosSesiones();
    const renovada = await s.casos.renovarSesion(s.a.refreshToken);
    await s.casos.cerrarSesion(s.a.refreshToken);
    await expect(s.casos.renovarSesion(renovada.refreshToken)).rejects.toBeInstanceOf(RefreshInvalido);
  });

  it('es idempotente: cerrar dos veces no da error', async () => {
    const s = await conDosSesiones();
    await s.casos.cerrarSesion(s.a.refreshToken);
    await expect(s.casos.cerrarSesion(s.a.refreshToken)).resolves.toBeUndefined();
  });

  it('un token desconocido no es un error y no toca nada', async () => {
    const s = await conDosSesiones();
    await expect(s.casos.cerrarSesion('no-existe')).resolves.toBeUndefined();
    expect([...s.sesiones.tokens.values()].every((t) => !t.revocadoEn)).toBe(true);
  });

  it('si la revocación falla, el error sube: no se informa una sesión cerrada que sigue abierta', async () => {
    const s = await conDosSesiones();
    s.sesiones.revocarFamilia = async () => {
      throw new Error('postgres no responde');
    };
    await expect(s.casos.cerrarSesion(s.a.refreshToken)).rejects.toThrow('postgres no responde');
  });

  it('no emite tokens', async () => {
    const s = await conDosSesiones();
    const emitidos = s.emisor.emitidos.length;
    await s.casos.cerrarSesion(s.a.refreshToken);
    expect(s.emisor.emitidos).toHaveLength(emitidos);
  });
});
