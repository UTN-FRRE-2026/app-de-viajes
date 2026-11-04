import { describe, expect, it } from 'vitest';
import { Usuario, type Rol } from '../../src/dominio/entidades/index.js';
import { CredencialesInvalidas, IdentificadorEnUso, RolNoRegistrable } from '../../src/dominio/errores/index.js';
import { CONTRASENA, sistemaEnMemoria } from '../soporte/memoria.js';

const entrada = (extra = {}) => ({ email: 'ana@viajes.test', contrasena: CONTRASENA, nombre: 'Ana', rol: 'pasajero', ...extra });

describe('registrar usuario', () => {
  it.each(['pasajero', 'chofer'])('registra un %s', async (rol) => {
    const { casos, repo } = sistemaEnMemoria();
    const usuario = await casos.registrarUsuario(entrada({ rol }));
    expect(usuario).toMatchObject({ email: 'ana@viajes.test', nombre: 'Ana', rol });
    expect(repo.usuarios.size).toBe(1);
  });

  it('guarda el hash y no devuelve ni el hash ni la contraseña', async () => {
    const { casos, repo } = sistemaEnMemoria();
    const usuario = await casos.registrarUsuario(entrada());
    expect(repo.usuarios.get('ana@viajes.test')?.hashContrasena).toBe(`hash:${CONTRASENA}`);
    expect(JSON.stringify(usuario)).not.toContain(CONTRASENA);
    expect(usuario).not.toHaveProperty('hashContrasena');
  });

  it('el email se normaliza antes de guardarlo', async () => {
    const { casos, repo } = sistemaEnMemoria();
    await casos.registrarUsuario(entrada({ email: '  Ana@VIAJES.test ' }));
    expect([...repo.usuarios.keys()]).toEqual(['ana@viajes.test']);
  });

  it('un email repetido falla, aunque cambien las mayúsculas', async () => {
    const { casos, repo } = sistemaEnMemoria();
    await casos.registrarUsuario(entrada());
    await expect(casos.registrarUsuario(entrada({ email: 'ANA@viajes.test' }))).rejects.toBeInstanceOf(IdentificadorEnUso);
    expect(repo.usuarios.size).toBe(1);
  });

  it.each(['admin', 'operador', 'admin_flota', 'cualquier-cosa', ''])('rechaza el rol %j sin hashear ni guardar', async (rol) => {
    const { casos, repo, hasher } = sistemaEnMemoria();
    await expect(casos.registrarUsuario(entrada({ rol }))).rejects.toBeInstanceOf(RolNoRegistrable);
    expect(hasher.hashes).toBe(0);
    expect(repo.usuarios.size).toBe(0);
  });
});

describe('entidad Usuario', () => {
  const base = { id: 'id', email: 'a@b.test', hashContrasena: 'h', nombre: 'A', creadoEn: new Date() };

  it('registrar rechaza un rol privilegiado aunque se llame directo', () => {
    expect(() => Usuario.registrar({ ...base, rol: 'admin' })).toThrow(RolNoRegistrable);
  });

  it('un usuario registrado nunca queda con flota', () => {
    expect(Usuario.registrar({ ...base, rol: 'chofer' }).fleetId).toBeNull();
  });
});

describe('iniciar sesión', () => {
  it('con la contraseña correcta emite un token con sub y rol', async () => {
    const { casos, emisor } = sistemaEnMemoria();
    const creado = await casos.registrarUsuario(entrada());
    const sesion = await casos.iniciarSesion({ email: 'ana@viajes.test', contrasena: CONTRASENA });
    expect(sesion).toMatchObject({ token: 'token-falso', expiraEnSegundos: 900, usuario: { id: creado.id, rol: 'pasajero' } });
    expect(emisor.emitidos).toEqual([{ sub: creado.id, rol: 'pasajero' }]);
  });

  it('acepta el email con otras mayúsculas', async () => {
    const { casos } = sistemaEnMemoria();
    await casos.registrarUsuario(entrada());
    await expect(casos.iniciarSesion({ email: 'ANA@viajes.test', contrasena: CONTRASENA })).resolves.toBeTruthy();
  });

  it('contraseña incorrecta → CredencialesInvalidas y no emite token', async () => {
    const { casos, emisor } = sistemaEnMemoria();
    await casos.registrarUsuario(entrada());
    await expect(casos.iniciarSesion({ email: 'ana@viajes.test', contrasena: 'otra' })).rejects.toBeInstanceOf(CredencialesInvalidas);
    expect(emisor.emitidos).toEqual([]);
  });

  it('usuario inexistente → mismo error, y hace el trabajo señuelo', async () => {
    const { casos, hasher } = sistemaEnMemoria();
    await expect(casos.iniciarSesion({ email: 'nadie@viajes.test', contrasena: 'x' })).rejects.toBeInstanceOf(CredencialesInvalidas);
    expect(hasher.simulaciones).toBe(1);
  });

  it('admin_flota lleva fleetId en los claims; el resto no', async () => {
    const { casos, repo, emisor } = sistemaEnMemoria();
    const crear = (rol: Rol, fleetId: string | null) =>
      repo.insertar(
        Usuario.reconstruir({
          id: `id-${rol}`,
          email: `${rol}@viajes.test`,
          hashContrasena: `hash:${CONTRASENA}`,
          nombre: rol,
          rol,
          fleetId,
          creadoEn: new Date(),
        }),
      );
    await crear('admin_flota', 'flota-1');
    await crear('admin', null);

    await casos.iniciarSesion({ email: 'admin_flota@viajes.test', contrasena: CONTRASENA });
    await casos.iniciarSesion({ email: 'admin@viajes.test', contrasena: CONTRASENA });

    expect(emisor.emitidos).toEqual([
      { sub: 'id-admin_flota', rol: 'admin_flota', fleetId: 'flota-1' },
      { sub: 'id-admin', rol: 'admin' },
    ]);
  });
});
