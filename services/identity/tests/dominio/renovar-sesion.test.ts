import { describe, expect, it } from 'vitest';
import { Usuario } from '../../src/dominio/entidades/index.js';
import { RefreshInvalido } from '../../src/dominio/errores/index.js';
import { CONTRASENA, REFRESH_TTL_SEGUNDOS, sistemaEnMemoria } from '../soporte/memoria.js';

const credenciales = { email: 'ana@viajes.test', contrasena: CONTRASENA };

async function conSesion() {
  const s = sistemaEnMemoria();
  const usuario = await s.casos.registrarUsuario({ ...credenciales, nombre: 'Ana', rol: 'pasajero' });
  const sesion = await s.casos.iniciarSesion(credenciales);
  return { ...s, usuario, sesion };
}

describe('login con refresh', () => {
  it('devuelve un refresh token y guarda solo su huella', async () => {
    const { sesion, sesiones, usuario } = await conSesion();
    expect(sesion).toMatchObject({ refreshToken: 'refresh-1', refreshExpiraEnSegundos: REFRESH_TTL_SEGUNDOS });
    expect([...sesiones.tokens.keys()]).toEqual(['huella:refresh-1']);
    expect(sesiones.tokens.get('huella:refresh-1')).toMatchObject({ usuarioId: usuario.id, usadoEn: null, revocadoEn: null });
  });

  it('cada login abre una familia distinta', async () => {
    const { casos, sesiones } = await conSesion();
    await casos.iniciarSesion(credenciales);
    const familias = new Set([...sesiones.tokens.values()].map((t) => t.familiaId));
    expect(familias.size).toBe(2);
  });

  it('un login fallido no crea refresh', async () => {
    const { casos, sesiones } = await conSesion();
    await expect(casos.iniciarSesion({ ...credenciales, contrasena: 'otra' })).rejects.toThrow();
    expect(sesiones.tokens.size).toBe(1);
  });
});

describe('renovar sesión', () => {
  it('rota: entrega un refresh nuevo de la misma familia y un access token nuevo', async () => {
    const { casos, sesion, sesiones, emisor, usuario } = await conSesion();
    const renovada = await casos.renovarSesion(sesion.refreshToken);

    expect(renovada).toMatchObject({ token: 'token-falso', refreshToken: 'refresh-2', usuario: { id: usuario.id } });
    const viejo = sesiones.tokens.get('huella:refresh-1');
    const nuevo = sesiones.tokens.get('huella:refresh-2');
    expect(viejo?.usadoEn).not.toBeNull();
    expect(nuevo).toMatchObject({ familiaId: viejo?.familiaId, usuarioId: usuario.id, usadoEn: null });
    expect(emisor.emitidos).toHaveLength(2);
  });

  it('se puede encadenar: cada refresh nuevo sirve para el siguiente', async () => {
    const { casos, sesion } = await conSesion();
    const segunda = await casos.renovarSesion(sesion.refreshToken);
    const tercera = await casos.renovarSesion(segunda.refreshToken);
    expect(tercera.refreshToken).toBe('refresh-3');
  });

  it('el plazo se renueva en cada rotación', async () => {
    const { casos, sesion, sesiones, reloj } = await conSesion();
    reloj.avanzar(3600_000);
    await casos.renovarSesion(sesion.refreshToken);
    expect(sesiones.tokens.get('huella:refresh-2')?.expiraEn).toEqual(new Date(reloj.ahora().getTime() + REFRESH_TTL_SEGUNDOS * 1000));
  });

  it('reusar un refresh ya rotado revoca toda la familia, también el último', async () => {
    const { casos, sesion, sesiones } = await conSesion();
    const renovada = await casos.renovarSesion(sesion.refreshToken);

    await expect(casos.renovarSesion(sesion.refreshToken)).rejects.toBeInstanceOf(RefreshInvalido);
    expect([...sesiones.tokens.values()].every((t) => t.revocadoEn)).toBe(true);
    await expect(casos.renovarSesion(renovada.refreshToken)).rejects.toBeInstanceOf(RefreshInvalido);
  });

  it('el reuso no toca las sesiones de otros logins', async () => {
    const { casos, sesion } = await conSesion();
    const otroDispositivo = await casos.iniciarSesion(credenciales);
    await casos.renovarSesion(sesion.refreshToken);
    await expect(casos.renovarSesion(sesion.refreshToken)).rejects.toBeInstanceOf(RefreshInvalido);
    await expect(casos.renovarSesion(otroDispositivo.refreshToken)).resolves.toBeTruthy();
  });

  it('un refresh vencido no sirve y no revoca nada', async () => {
    const { casos, sesion, sesiones, reloj } = await conSesion();
    reloj.avanzar(REFRESH_TTL_SEGUNDOS * 1000);
    await expect(casos.renovarSesion(sesion.refreshToken)).rejects.toBeInstanceOf(RefreshInvalido);
    expect(sesiones.tokens.get('huella:refresh-1')).toMatchObject({ usadoEn: null, revocadoEn: null });
  });

  it('un refresh inventado → RefreshInvalido sin emitir token', async () => {
    const { casos, emisor } = await conSesion();
    await expect(casos.renovarSesion('cualquier-cosa')).rejects.toBeInstanceOf(RefreshInvalido);
    expect(emisor.emitidos).toHaveLength(1);
  });

  it('los claims salen del usuario actual, no del login', async () => {
    const { casos, sesion, repo, emisor, usuario } = await conSesion();
    const datos = repo.usuarios.get('ana@viajes.test');
    if (!datos) throw new Error('falta el usuario');
    repo.usuarios.set(datos.email, Usuario.reconstruir({ ...datos, rol: 'admin_flota', fleetId: 'flota-1' }).aDatos());

    await casos.renovarSesion(sesion.refreshToken);
    expect(emisor.emitidos.at(-1)).toEqual({ sub: usuario.id, rol: 'admin_flota', fleetId: 'flota-1' });
  });

  it('si el usuario ya no existe → RefreshInvalido', async () => {
    const { casos, sesion, repo } = await conSesion();
    repo.usuarios.clear();
    await expect(casos.renovarSesion(sesion.refreshToken)).rejects.toBeInstanceOf(RefreshInvalido);
  });
});
