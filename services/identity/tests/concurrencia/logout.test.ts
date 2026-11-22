import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generadorRefresh } from '../../src/infra/externos/generador-refresh.js';
import { clave, CONTRASENA, datosRegistro, levantarIdentity, type Identity } from '../soporte/sistema.js';

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

const entrar = () =>
  request(d.url).post('/login').send({ email: 'ana@viajes.test', contrasena: CONTRASENA }).expect(200).then((r) => r.body);
const refrescar = (refreshToken: string) => request(d.url).post('/refresh').send({ refreshToken });
const cerrar = (refreshToken: string) => request(d.url).post('/logout').send({ refreshToken });

/** La familia (sesión) de un refresh, buscada por su huella como lo hace identity. */
const familiaDe = async (refreshToken: string) =>
  (await d.prisma.refreshToken.findUniqueOrThrow({ where: { huella: generadorRefresh.huella(refreshToken) } })).familiaId;

/** Solo en estos tests: cada INSERT en refresh_tokens tarda 1 s, así la rotación queda abierta. */
async function conInsercionLenta<T>(trabajo: () => Promise<T>): Promise<T> {
  await d.prisma.$executeRawUnsafe(`
    CREATE FUNCTION demora_test() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$`);
  await d.prisma.$executeRawUnsafe(
    'CREATE TRIGGER demora_test BEFORE INSERT ON refresh_tokens FOR EACH ROW EXECUTE FUNCTION demora_test()',
  );
  try {
    return await trabajo();
  } finally {
    await d.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS demora_test ON refresh_tokens');
    await d.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS demora_test()');
  }
}

describe('logout y refresh al mismo tiempo, contra Postgres', () => {
  // Protección: el lock por familia que toma revocarFamilia (el mismo que usa la detección de
  // reuso). Sin él, el UPDATE del logout espera la fila del token que se está rotando y, al seguir,
  // no ve el token recién creado: la sesión "cerrada" seguiría renovándose.
  it('un refresh en curso cuando llega el logout → su token nuevo nace revocado', async () => {
    await request(d.url).post('/registro').set(clave()).send(datosRegistro()).expect(201);
    const a = await entrar();
    const otra = await entrar();

    const { rotada, logout } = await conInsercionLenta(async () => {
      const rotacion = refrescar(a.refreshToken).then((r) => r);
      await new Promise((r) => setTimeout(r, 300));
      const logout = await cerrar(a.refreshToken);
      return { rotada: await rotacion, logout };
    });

    expect(logout.status).toBe(204);
    // La renovación había empezado antes: termina bien, pero su refresh no sirve.
    expect(rotada.status).toBe(200);
    expect((await refrescar(rotada.body.refreshToken)).status).toBe(401);

    const familiaA = await familiaDe(a.refreshToken);
    expect(await familiaDe(rotada.body.refreshToken)).toBe(familiaA);
    expect(await d.prisma.refreshToken.count({ where: { familiaId: familiaA } })).toBe(2);
    expect(await d.prisma.refreshToken.count({ where: { familiaId: familiaA, revocadoEn: null } })).toBe(0);
    // La otra sesión no se enteró.
    expect((await refrescar(otra.refreshToken)).status).toBe(200);
  });

  it('20 refresh simultáneos con un logout en el medio → ningún token de la sesión queda vivo', async () => {
    await request(d.url).post('/registro').set(clave()).send(datosRegistro()).expect(201);
    const a = await entrar();

    const pedidos = [
      ...Array.from({ length: 10 }, () => refrescar(a.refreshToken).then((r) => r)),
      cerrar(a.refreshToken).then((r) => r),
      ...Array.from({ length: 10 }, () => refrescar(a.refreshToken).then((r) => r)),
    ];
    const respuestas = await Promise.all(pedidos);

    expect(respuestas[10]?.status).toBe(204);
    expect(await d.prisma.refreshToken.count({ where: { revocadoEn: null } })).toBe(0);
    for (const r of respuestas.filter((x) => x.status === 200)) {
      expect((await refrescar(r.body.refreshToken)).status).toBe(401);
    }
  });
});
