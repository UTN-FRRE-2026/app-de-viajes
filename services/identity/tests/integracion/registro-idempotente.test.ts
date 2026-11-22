import { randomUUID } from 'node:crypto';
import { almacenIdempotenciaSql, cerrojoRedis } from '@viajes/platform';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPrisma } from '../../src/infra/db/cliente.js';
import { HasherArgon2 } from '../../src/infra/externos/hasher-argon2.js';
import { URL_BD_TEST, URL_REDIS_TEST } from '../soporte/preparar-bd.js';
import { CONTRASENA, datosRegistro, levantarIdentity, type Identity } from '../soporte/sistema.js';

/** argon2 real, contando cuántos registros llegaron a hashear la contraseña. */
class HasherContado extends HasherArgon2 {
  hashes = 0;

  override hashear(contrasena: string) {
    this.hashes += 1;
    return super.hashear(contrasena);
  }
}

const hasher = new HasherContado();
let d: Identity;

beforeAll(async () => {
  d = await levantarIdentity({ reemplazos: { hasher } });
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
  hasher.hashes = 0;
});

const registrar = (clave: string, extra: Record<string, unknown> = {}) =>
  request(d.url).post('/registro').set('Idempotency-Key', clave).send(datosRegistro(extra));

describe('POST /registro con Idempotency-Key', () => {
  it('sin la clave, o con una inválida → 400, y no se crea nadie', async () => {
    const sin = await request(d.url).post('/registro').send(datosRegistro());
    expect(sin.status).toBe(400);
    expect(sin.body.error.code).toBe('CLAVE_IDEMPOTENCIA_INVALIDA');
    expect((await registrar('corta')).status).toBe(400);
    expect(await d.prisma.usuario.count()).toBe(0);
    expect(hasher.hashes).toBe(0);
  });

  // Protección: el middleware en la ruta. Sin él, el reintento recibe 409 IDENTIFICADOR_EN_USO.
  it('el reintento con la misma clave recibe el mismo 201, sin volver a correr argon2', async () => {
    const clave = randomUUID();
    const primero = await registrar(clave);
    expect(primero.status).toBe(201);
    expect(primero.headers['idempotent-replayed']).toBeUndefined();

    const reintento = await registrar(clave);
    expect(reintento.status).toBe(201);
    expect(reintento.headers['idempotent-replayed']).toBe('true');
    expect(reintento.text).toBe(primero.text);
    expect(hasher.hashes).toBe(1);
    expect(await d.prisma.usuario.count()).toBe(1);
    expect(await d.prisma.registroIdempotencia.count()).toBe(1);
  });

  it('otra clave con el mismo email sigue siendo 409: la clave no saltea la unicidad', async () => {
    await registrar(randomUUID()).expect(201);
    const otra = await registrar(randomUUID());
    expect(otra.status).toBe(409);
    expect(otra.body.error.code).toBe('IDENTIFICADOR_EN_USO');
  });

  it('la misma clave con otro nombre o rol → 422; con otro email es otro registro', async () => {
    const clave = randomUUID();
    await registrar(clave).expect(201);
    const otroNombre = await registrar(clave, { nombre: 'Otra' });
    expect(otroNombre.status).toBe(422);
    expect(otroNombre.body.error.code).toBe('CLAVE_IDEMPOTENCIA_REUTILIZADA');
    expect((await registrar(clave, { rol: 'chofer' })).status).toBe(422);

    // La clave es de un email: con otro email, la misma clave no repite la respuesta de Ana.
    const beto = await registrar(clave, { email: 'beto@viajes.test' });
    expect(beto.status).toBe(201);
    expect(beto.headers['idempotent-replayed']).toBeUndefined();
    expect(beto.body.email).toBe('beto@viajes.test');
  });

  // La huella se guarda en la base: con la contraseña adentro, un SHA-256 sin sal permitiría probar
  // contraseñas con una copia de la base. Por eso otra contraseña con la misma clave es un reintento.
  it('la contraseña no entra en la huella ni en lo guardado; la cuenta queda con la primera', async () => {
    const clave = randomUUID();
    await registrar(clave).expect(201);
    const otra = await registrar(clave, { contrasena: 'otra-contrasena-distinta' });
    expect(otra.status).toBe(201);
    expect(otra.headers['idempotent-replayed']).toBe('true');

    const [fila] = await d.prisma.registroIdempotencia.findMany();
    expect(JSON.stringify(fila)).not.toContain(CONTRASENA);
    expect(fila!.alcance).not.toContain('ana@viajes.test');
    await request(d.url).post('/login').send({ email: 'ana@viajes.test', contrasena: CONTRASENA }).expect(200);
    await request(d.url).post('/login').send({ email: 'ana@viajes.test', contrasena: 'otra-contrasena-distinta' }).expect(401);
  });

  it('la purga borra lo vencido; pasada la retención, la misma clave vuelve a ejecutar el registro', async () => {
    const clave = randomUUID();
    await registrar(clave).expect(201);
    expect(await d.purgarIdempotencia()).toBe(0);

    await d.prisma.$executeRaw`UPDATE idempotency_keys SET created_at = now() - interval '25 hours'`;
    expect(await d.purgarIdempotencia()).toBe(1);
    const otraVez = await registrar(clave);
    expect(otraVez.headers['idempotent-replayed']).toBeUndefined();
    expect(otraVez.status).toBe(409);
  });
});

/**
 * El registro de la clave confirma en la misma transacción que el usuario. Se prueba con un almacén
 * que no guarda después de responder (como si el proceso se cayera ahí): la respuesta del reintento
 * solo puede venir de lo que se escribió en la transacción.
 */
describe('registro de la clave en la transacción del usuario', () => {
  let sinRespaldo: Identity;
  let redis: Redis;
  const prisma = crearPrisma(URL_BD_TEST, 2);

  beforeAll(async () => {
    redis = new Redis(URL_REDIS_TEST);
    const sql = almacenIdempotenciaSql(prisma);
    sinRespaldo = await levantarIdentity({
      reemplazos: {
        idempotencia: { almacen: { buscar: sql.buscar, guardar: async () => {} }, cerrojo: cerrojoRedis(redis, 'identity-test:idem:') },
      },
    });
  });
  afterAll(async () => {
    await sinRespaldo.cerrar();
    await prisma.$disconnect();
    redis.disconnect();
  });

  // Protección: registrarIdempotenciaEnTransaccion en el repositorio. Sin ella, el reintento recibe 409.
  it('el reintento recibe el 201 aunque no se haya guardado nada después de responder', async () => {
    const clave = randomUUID();
    const pedir = () => request(sinRespaldo.url).post('/registro').set('Idempotency-Key', clave).send(datosRegistro());
    const primero = await pedir();
    expect(primero.status).toBe(201);
    const reintento = await pedir();
    expect(reintento.status).toBe(201);
    expect(reintento.headers['idempotent-replayed']).toBe('true');
    expect(reintento.text).toBe(primero.text);
  });
});
