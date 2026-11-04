import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CONTRASENA, datosRegistro, levantarIdentity, type Identity } from '../soporte/sistema.js';

let d: Identity;

beforeAll(async () => {
  d = await levantarIdentity();
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
});

const FLOTA = '00000000-0000-4000-8000-0000000000f1';

describe('elevación de privilegios en el registro', () => {
  it.each(['admin', 'operador', 'admin_flota', 'ADMIN', ''])('rol %j → 400 y no crea nada', async (rol) => {
    const res = await request(d.url).post('/registro').send(datosRegistro({ rol }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDACION');
    expect(await d.prisma.usuario.count()).toBe(0);
  });

  it.each([
    ['fleetId', { fleetId: FLOTA }],
    ['id elegido por el cliente', { id: FLOTA }],
    ['hash propio', { hashContrasena: 'x' }],
    ['roles en plural', { roles: ['admin'] }],
    ['admin como bandera', { admin: true }],
  ])('%s → 400 y no crea nada', async (_nombre, extra) => {
    const res = await request(d.url).post('/registro').send(datosRegistro(extra));
    expect(res.status).toBe(400);
    expect(await d.prisma.usuario.count()).toBe(0);
  });

  it('sin rol → 400: no hay rol por defecto', async () => {
    const { rol: _rol, ...sinRol } = datosRegistro();
    expect((await request(d.url).post('/registro').send(sinRol)).status).toBe(400);
  });

  it('__proto__ en el body → 400 y no contamina el objeto', async () => {
    const crudo = `{"email":"ana@viajes.test","contrasena":"${CONTRASENA}","nombre":"Ana","rol":"pasajero","__proto__":{"rol":"admin"}}`;
    const res = await request(d.url).post('/registro').set('content-type', 'application/json').send(crudo);
    expect(res.status).toBe(400);
    expect(({} as Record<string, unknown>)['rol']).toBeUndefined();
    expect(await d.prisma.usuario.count()).toBe(0);
  });

  it('el login tampoco acepta claves extra → 400', async () => {
    const res = await request(d.url).post('/login').send({ email: 'ana@viajes.test', contrasena: CONTRASENA, rol: 'admin' });
    expect(res.status).toBe(400);
  });
});

describe('validación estricta', () => {
  it.each([
    ['email inválido', { email: 'no-es-email' }],
    ['contraseña corta', { contrasena: 'corta' }],
    ['contraseña enorme', { contrasena: 'x'.repeat(129) }],
    ['nombre vacío', { nombre: '   ' }],
    ['email que no es texto', { email: { $ne: null } }],
  ])('%s → 400', async (_nombre, extra) => {
    expect((await request(d.url).post('/registro').send(datosRegistro(extra))).status).toBe(400);
  });

  it('JSON mal formado → 400', async () => {
    const res = await request(d.url).post('/login').set('content-type', 'application/json').send('{nope');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('JSON_INVALIDO');
  });

  it('cuerpo demasiado grande → 413', async () => {
    const res = await request(d.url).post('/registro').send(datosRegistro({ nombre: 'x'.repeat(20_000) }));
    expect(res.status).toBe(413);
  });
});

describe('no filtra información', () => {
  it('email inexistente y contraseña incorrecta responden lo mismo', async () => {
    await request(d.url).post('/registro').send(datosRegistro()).expect(201);
    const conEmail = await request(d.url).post('/login').send({ email: 'ana@viajes.test', contrasena: 'incorrecta-123' });
    const sinEmail = await request(d.url).post('/login').send({ email: 'nadie@viajes.test', contrasena: 'incorrecta-123' });
    expect(conEmail.status).toBe(401);
    expect(sinEmail.status).toBe(401);
    expect({ ...conEmail.body.error, requestId: 0 }).toEqual({ ...sinEmail.body.error, requestId: 0 });
  });

  it('ni el registro ni el login devuelven el hash o la contraseña', async () => {
    const registro = await request(d.url).post('/registro').send(datosRegistro());
    const login = await request(d.url).post('/login').send({ email: 'ana@viajes.test', contrasena: CONTRASENA });
    for (const res of [registro, login]) {
      expect(res.text).not.toContain(CONTRASENA);
      expect(res.text).not.toContain('argon2');
    }
  });

  it('un error de validación no repite la contraseña', async () => {
    const res = await request(d.url).post('/registro').send(datosRegistro({ contrasena: 'corta-secreta', extra: 1 }));
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('corta-secreta');
  });
});

describe('JWKS', () => {
  it('publica solo la clave pública, con caché', async () => {
    const res = await request(d.url).get('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body.keys).toHaveLength(1);
    const [clave] = res.body.keys;
    expect(clave).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', kid: expect.any(String) });
    for (const privado of ['d', 'p', 'q', 'dp', 'dq', 'qi']) expect(clave).not.toHaveProperty(privado);
  });
});
