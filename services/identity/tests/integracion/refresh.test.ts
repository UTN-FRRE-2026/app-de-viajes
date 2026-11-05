import { createHash } from 'node:crypto';
import { decodeJwt } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RelojFalso } from '../soporte/memoria.js';
import { CONTRASENA, datosRegistro, levantarIdentity, type Identity } from '../soporte/sistema.js';

const TTL_REFRESH = 3600;
const reloj = new RelojFalso(new Date());
let d: Identity;

beforeAll(async () => {
  d = await levantarIdentity({ config: { IDENTITY_REFRESH_TTL_SEGUNDOS: String(TTL_REFRESH) }, reemplazos: { reloj } });
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
});

const refrescar = (refreshToken: unknown) => request(d.url).post('/refresh').send({ refreshToken });

async function entrar() {
  const { body: usuario } = await request(d.url).post('/registro').send(datosRegistro()).expect(201);
  const { body: sesion } = await request(d.url).post('/login').send({ email: 'ana@viajes.test', contrasena: CONTRASENA }).expect(200);
  return { usuario, sesion };
}

describe('login con refresh contra Postgres', () => {
  it('devuelve el refresh y guarda solo su SHA-256', async () => {
    const { usuario, sesion } = await entrar();
    expect(sesion).toMatchObject({ refreshToken: expect.any(String), refreshExpiraEnSegundos: TTL_REFRESH });
    expect(sesion.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const filas = await d.prisma.refreshToken.findMany();
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      huella: createHash('sha256').update(sesion.refreshToken).digest('base64url'),
      usuarioId: usuario.id,
      usadoEn: null,
      revocadoEn: null,
    });
    expect(JSON.stringify(filas)).not.toContain(sesion.refreshToken);
  });
});

describe('POST /refresh', () => {
  it('rota: access y refresh nuevos, el viejo queda usado', async () => {
    const { usuario, sesion } = await entrar();
    const res = await refrescar(sesion.refreshToken);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ tipo: 'Bearer', expiraEnSegundos: 900, usuario: { id: usuario.id, rol: 'pasajero' } });
    expect(res.body.refreshToken).not.toBe(sesion.refreshToken);
    const claims = decodeJwt(res.body.token);
    expect(claims).toMatchObject({ sub: usuario.id, rol: 'pasajero' });
    expect(claims.jti).not.toBe(decodeJwt(sesion.token).jti);

    const filas = await d.prisma.refreshToken.findMany({ orderBy: { creadoEn: 'asc' } });
    expect(filas).toHaveLength(2);
    expect(filas[0]?.usadoEn).not.toBeNull();
    expect(filas[1]).toMatchObject({ familiaId: filas[0]?.familiaId, usadoEn: null });
  });

  it('reusar un refresh rotado → 401 y revoca la familia entera', async () => {
    const { sesion } = await entrar();
    const { body: renovada } = await refrescar(sesion.refreshToken).expect(200);

    const reuso = await refrescar(sesion.refreshToken);
    expect(reuso.status).toBe(401);
    expect(reuso.body.error.code).toBe('REFRESH_INVALIDO');
    expect(await d.prisma.refreshToken.count({ where: { revocadoEn: null } })).toBe(0);
    expect((await refrescar(renovada.refreshToken)).status).toBe(401);
  });

  it('el reuso en una sesión no corta las otras del mismo usuario', async () => {
    const { sesion } = await entrar();
    const { body: otra } = await request(d.url).post('/login').send({ email: 'ana@viajes.test', contrasena: CONTRASENA });
    await refrescar(sesion.refreshToken).expect(200);
    await refrescar(sesion.refreshToken).expect(401);
    expect((await refrescar(otra.refreshToken)).status).toBe(200);
  });

  it('vencido → 401, sin marcarlo usado', async () => {
    const { sesion } = await entrar();
    reloj.avanzar(TTL_REFRESH * 1000);
    const res = await refrescar(sesion.refreshToken);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REFRESH_INVALIDO');
    expect(await d.prisma.refreshToken.findFirst()).toMatchObject({ usadoEn: null, revocadoEn: null });
  });

  it('inventado → 401 con el mismo código', async () => {
    await entrar();
    const res = await refrescar('a'.repeat(43));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REFRESH_INVALIDO');
  });

  it.each([
    ['sin refreshToken', {}],
    ['vacío', { refreshToken: '' }],
    ['no es texto', { refreshToken: 123 }],
    ['demasiado largo', { refreshToken: 'a'.repeat(257) }],
    ['clave extra', { refreshToken: 'x', usuarioId: '00000000-0000-4000-8000-000000000004' }],
  ])('%s → 400', async (_nombre, body) => {
    const res = await request(d.url).post('/refresh').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDACION');
  });

  it('el refresh toma el rol actual del usuario', async () => {
    const { usuario, sesion } = await entrar();
    await d.prisma.usuario.update({ where: { id: usuario.id }, data: { rol: 'chofer' } });
    const res = await refrescar(sesion.refreshToken).expect(200);
    expect(decodeJwt(res.body.token)).toMatchObject({ sub: usuario.id, rol: 'chofer' });
  });

  it('borrar el usuario borra sus refresh tokens', async () => {
    const { usuario, sesion } = await entrar();
    await d.prisma.usuario.delete({ where: { id: usuario.id } });
    expect(await d.prisma.refreshToken.count()).toBe(0);
    expect((await refrescar(sesion.refreshToken)).status).toBe(401);
  });
});
