import { verificadorJwksLocal } from '@viajes/platform';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPrisma } from '../../src/infra/db/cliente.js';
import { RepositorioSesionesPrisma } from '../../src/infra/db/repositorio-prisma.js';
import { generadorRefresh } from '../../src/infra/externos/generador-refresh.js';
import { URL_BD_TEST } from '../soporte/preparar-bd.js';
import { AUDIENCE, CONTRASENA, datosRegistro, ISSUER, levantarIdentity, type Identity } from '../soporte/sistema.js';

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

const entrar = (url = d.url) =>
  request(url).post('/login').send({ email: 'ana@viajes.test', contrasena: CONTRASENA }).expect(200).then((r) => r.body);
const refrescar = (refreshToken: unknown, url = d.url) => request(url).post('/refresh').send({ refreshToken });
const cerrar = (refreshToken: unknown, url = d.url) => request(url).post('/logout').send({ refreshToken });

async function dosSesiones() {
  const { body: usuario } = await request(d.url).post('/registro').send(datosRegistro()).expect(201);
  return { usuario, a: await entrar(), b: await entrar() };
}

describe('POST /logout contra Postgres', () => {
  it('responde 204 sin cuerpo, y después ese refresh da 401', async () => {
    const { a } = await dosSesiones();
    const res = await cerrar(a.refreshToken);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    const despues = await refrescar(a.refreshToken);
    expect(despues.status).toBe(401);
    expect(despues.body.error.code).toBe('REFRESH_INVALIDO');
  });

  it('la otra sesión del mismo usuario sigue renovando', async () => {
    const { a, b } = await dosSesiones();
    await cerrar(a.refreshToken).expect(204);
    expect((await refrescar(b.refreshToken)).status).toBe(200);
  });

  it('revoca en la base todas las filas de esa familia y ninguna de la otra', async () => {
    const { a, b } = await dosSesiones();
    const renovada = await refrescar(a.refreshToken).expect(200);
    await cerrar(renovada.body.refreshToken).expect(204);

    const familiaDe = async (token: string) =>
      (await d.prisma.refreshToken.findUniqueOrThrow({ where: { huella: generadorRefresh.huella(token) } })).familiaId;
    const [familiaA, familiaB] = [await familiaDe(a.refreshToken), await familiaDe(b.refreshToken)];
    expect(await d.prisma.refreshToken.count({ where: { familiaId: familiaA } })).toBe(2);
    expect(await d.prisma.refreshToken.count({ where: { familiaId: familiaA, revocadoEn: null } })).toBe(0);
    expect(await d.prisma.refreshToken.count({ where: { familiaId: familiaB, revocadoEn: { not: null } } })).toBe(0);
  });

  it('con un refresh ya rotado también cierra la sesión vigente', async () => {
    const { a } = await dosSesiones();
    const renovada = await refrescar(a.refreshToken).expect(200);
    await cerrar(a.refreshToken).expect(204);
    expect((await refrescar(renovada.body.refreshToken)).status).toBe(401);
  });

  it('es idempotente, y un token desconocido también da 204', async () => {
    const { a } = await dosSesiones();
    await cerrar(a.refreshToken).expect(204);
    await cerrar(a.refreshToken).expect(204);
    await cerrar('x'.repeat(43)).expect(204);
  });

  it.each([
    ['sin refreshToken', {}],
    ['refreshToken que no es texto', { refreshToken: 123 }],
    ['refreshToken vacío', { refreshToken: '' }],
    ['refreshToken demasiado largo', { refreshToken: 'x'.repeat(257) }],
    ['clave extra', { refreshToken: 'x', todas: true }],
  ])('%s → 400', async (_caso, cuerpo) => {
    const res = await request(d.url).post('/logout').send(cuerpo);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDACION');
  });

  it('el access token ya emitido sigue verificando hasta su exp: logout no lo revoca', async () => {
    const { a } = await dosSesiones();
    await cerrar(a.refreshToken).expect(204);
    const { body: jwks } = await request(d.url).get('/.well-known/jwks.json');
    const verificar = verificadorJwksLocal(jwks, { issuer: ISSUER, audience: AUDIENCE });
    await expect(verificar(a.token)).resolves.toMatchObject({ rol: 'pasajero' });
  });
});

describe('si Postgres falla, el logout no responde 204', () => {
  it('base inaccesible → 500 sin detalles internos', async () => {
    const sinBase = await levantarIdentity({ config: { IDENTITY_DATABASE_URL: 'postgresql://identity_svc:x@127.0.0.1:1/identity' } });
    try {
      const res = await cerrar('x'.repeat(43), sinBase.url);
      expect(res.status).toBe(500);
      expect(res.body.error).toEqual({ code: 'INTERNO', message: 'Error interno', requestId: expect.any(String) });
    } finally {
      await sinBase.cerrar();
    }
  });

  it('falla la revocación → 500, y la sesión sigue abierta', async () => {
    const prisma = crearPrisma(URL_BD_TEST, 2);
    const real = new RepositorioSesionesPrisma(prisma);
    const sesiones = Object.assign(Object.create(real) as RepositorioSesionesPrisma, {
      revocarFamilia: async () => {
        throw new Error('conexión perdida');
      },
    });
    const conFalla = await levantarIdentity({ reemplazos: { sesiones } });
    try {
      await d.limpiar();
      await request(conFalla.url).post('/registro').send(datosRegistro()).expect(201);
      const sesion = await entrar(conFalla.url);

      expect((await cerrar(sesion.refreshToken, conFalla.url)).status).toBe(500);
      // No se le dijo al cliente que cerró: y, en efecto, la sesión sigue viva.
      expect((await refrescar(sesion.refreshToken, conFalla.url)).status).toBe(200);
    } finally {
      await conFalla.cerrar();
      await prisma.$disconnect();
    }
  });
});
