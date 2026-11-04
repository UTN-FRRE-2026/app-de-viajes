import { decodeJwt } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HasherArgon2 } from '../../src/infra/externos/hasher-argon2.js';
import { FLOTA_DEMO_ID, sembrarUsuarios, USUARIOS_SEMILLA } from '../../src/infra/db/semilla.js';
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

const registrar = (extra = {}) => request(d.url).post('/registro').send(datosRegistro(extra));
const login = (email: string, contrasena = CONTRASENA) => request(d.url).post('/login').send({ email, contrasena });

describe('registro contra Postgres', () => {
  it.each(['pasajero', 'chofer'])('registra un %s y lo persiste', async (rol) => {
    const res = await registrar({ rol });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      email: 'ana@viajes.test',
      nombre: 'Ana',
      rol,
      creadoEn: expect.any(String),
    });
    const fila = await d.prisma.usuario.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(fila).toMatchObject({ email: 'ana@viajes.test', rol, fleetId: null });
  });

  it('guarda argon2id con los parámetros declarados, nunca la contraseña', async () => {
    await registrar();
    const { hashContrasena } = await d.prisma.usuario.findUniqueOrThrow({ where: { email: 'ana@viajes.test' } });
    expect(hashContrasena).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hashContrasena).not.toContain(CONTRASENA);
  });

  it('email repetido → 409, también con otras mayúsculas', async () => {
    await registrar();
    const res = await registrar({ email: 'ANA@Viajes.Test', contrasena: 'otra-contrasena-valida' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDENTIFICADOR_EN_USO');
    expect(await d.prisma.usuario.count()).toBe(1);
  });
});

describe('restricciones de la base (por si algún camino de código falla)', () => {
  const fila = { id: '00000000-0000-4000-8000-0000000000aa', hashContrasena: 'x', nombre: 'x' };

  it.each([
    ['rol inventado', { email: 'a@x.test', rol: 'superusuario' }],
    ['admin_flota sin flota', { email: 'a@x.test', rol: 'admin_flota' }],
    ['pasajero con flota', { email: 'a@x.test', rol: 'pasajero', fleetId: FLOTA_DEMO_ID }],
    ['email con mayúsculas', { email: 'A@x.test', rol: 'pasajero' }],
  ])('rechaza %s', async (_nombre, datos) => {
    await expect(d.prisma.usuario.create({ data: { ...fila, ...datos } })).rejects.toThrow();
  });
});

describe('login contra Postgres', () => {
  it('devuelve un token RS256 con los claims del contrato', async () => {
    const { body: creado } = await registrar();
    const res = await login('ana@viajes.test');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ tipo: 'Bearer', expiraEnSegundos: 900, usuario: { id: creado.id, rol: 'pasajero' } });
    expect(decodeJwt(res.body.token)).toMatchObject({ sub: creado.id, rol: 'pasajero' });
  });

  it('contraseña incorrecta → 401 sin token', async () => {
    await registrar();
    const res = await login('ana@viajes.test', 'contrasena-incorrecta');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('CREDENCIALES_INVALIDAS');
    expect(res.body).not.toHaveProperty('token');
  });
});

describe('seed', () => {
  const hasher = new HasherArgon2();

  it('es idempotente y conserva los UUID fijos', async () => {
    await sembrarUsuarios(d.prisma, hasher, CONTRASENA);
    await sembrarUsuarios(d.prisma, hasher, CONTRASENA);
    const filas = await d.prisma.usuario.findMany({ orderBy: { id: 'asc' } });
    expect(filas.map((f) => f.id)).toEqual(USUARIOS_SEMILLA.map((u) => u.id));
    expect(filas.map((f) => f.rol)).toEqual(['pasajero', 'chofer', 'operador', 'admin', 'admin_flota']);
  });

  it('cada rol puede entrar, y solo admin_flota recibe fleetId', async () => {
    await sembrarUsuarios(d.prisma, hasher, CONTRASENA);
    for (const usuario of USUARIOS_SEMILLA) {
      const res = await login(usuario.email);
      expect(res.status).toBe(200);
      const claims = decodeJwt(res.body.token);
      expect(claims).toMatchObject({ sub: usuario.id, rol: usuario.rol });
      expect(claims['fleetId']).toBe(usuario.rol === 'admin_flota' ? FLOTA_DEMO_ID : undefined);
    }
  });
});

describe('salud', () => {
  it('/health responde y /ready chequea Postgres, migraciones y Redis', async () => {
    expect((await request(d.url).get('/health')).status).toBe(200);
    const res = await request(d.url).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ estado: 'listo', chequeos: { postgres: 'ok', migraciones: 'ok', redis: 'ok' } });
  });
});
