import { randomUUID } from 'node:crypto';
import { TarifaAdminRespuesta, TOPE_IMPORTE_CENTAVOS, TOPE_MAX_METROS } from '@viajes/contracts';
import type { Rol } from '@viajes/platform';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clave, levantarDispatch } from '../soporte/sistema-postgres.js';

/** GET y PUT /admin/tarifas contra Postgres y Redis reales. */
let d: Awaited<ReturnType<typeof levantarDispatch>>;

beforeAll(async () => {
  d = await levantarDispatch();
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiarTarifas();
  await d.prisma.$executeRawUnsafe('TRUNCATE idempotency_keys');
});

// La semilla de configTest: los valores por defecto de TARIFA_*.
const SEMILLA = { bajadaCentavos: 150_000, centavosPorKm: 80_000, centavosPorMinuto: 15_000, minimoCentavos: 250_000, maxMetros: 100_000 };
const NUEVA = { bajadaCentavos: 200_000, centavosPorKm: 90_000, centavosPorMinuto: 10_000, minimoCentavos: 300_000, maxMetros: 120_000 };

const versiones = () => d.prisma.tarifaVersion.count();
const cambios = () => d.prisma.cambioTarifa.count();
const registrosIdempotencia = () => d.prisma.registroIdempotencia.count();

const ver = async (rol: Rol = 'admin', id = randomUUID()) => request(d.url).get('/admin/tarifas').set(await d.auth(id, rol));
const configurar = async (cuerpo: object, encabezados: Record<string, string> = clave(), adminId = randomUUID()) =>
  request(d.url).put('/admin/tarifas').set(encabezados).set(await d.auth(adminId, 'admin')).send(cuerpo);

describe('permisos', () => {
  it('sin token → 401 en el GET y en el PUT', async () => {
    expect((await request(d.url).get('/admin/tarifas')).status).toBe(401);
    expect((await request(d.url).put('/admin/tarifas').set(clave()).send(NUEVA)).status).toBe(401);
  });

  it.each(['pasajero', 'chofer', 'operador'] as const)('%s → 403 en el GET y en el PUT, y no cambia nada', async (rol) => {
    const get = await ver(rol);
    const put = await request(d.url).put('/admin/tarifas').set(clave()).set(await d.auth(randomUUID(), rol)).send(NUEVA);
    expect(get.status).toBe(403);
    expect(put.status).toBe(403);
    expect(put.body.error.code).toBe('ROL_NO_PERMITIDO');
    expect(await d.prisma.tarifaVersion.count({ where: { version: { gt: 1 } } })).toBe(0);
  });
});

describe('GET /admin/tarifas', () => {
  it('devuelve la vigente con su versión; la primera vez, la semilla del entorno', async () => {
    const res = await ver();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(TarifaAdminRespuesta.parse(res.body)).toEqual({
      version: 'v1',
      moneda: 'ARS',
      ...SEMILLA,
      actualizadaPor: 'semilla',
      actualizadaEn: expect.any(String),
    });
  });
});

describe('PUT /admin/tarifas', () => {
  it('reemplaza la tarifa, devuelve la versión nueva y deja la auditoría con el autor del token', async () => {
    await ver();
    const admin = randomUUID();
    const res = await configurar(NUEVA, clave(), admin);

    expect(res.status).toBe(200);
    expect(TarifaAdminRespuesta.parse(res.body)).toEqual({
      version: 'v2',
      moneda: 'ARS',
      ...NUEVA,
      actualizadaPor: admin,
      actualizadaEn: expect.any(String),
    });
    expect((await ver()).body).toEqual(res.body);

    const cambio = await d.prisma.cambioTarifa.findUniqueOrThrow({ where: { version: 2 } });
    expect(cambio).toMatchObject({
      versionAnterior: 1,
      cambiadaPor: admin,
      valoresAnteriores: SEMILLA,
      valoresNuevos: NUEVA,
      requestId: res.headers['x-request-id'],
    });
    expect(await versiones()).toBe(2);
  });

  it('sin Idempotency-Key → 400 y no crea versión', async () => {
    await ver();
    const res = await request(d.url).put('/admin/tarifas').set(await d.auth(randomUUID(), 'admin')).send(NUEVA);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CLAVE_IDEMPOTENCIA_INVALIDA');
    expect(await versiones()).toBe(1);
  });

  it.each([
    ['un campo desconocido', { ...NUEVA, recargoNocturno: 10 }],
    ['la moneda (la pone el servidor)', { ...NUEVA, moneda: 'USD' }],
    ['la versión (la pone el servidor)', { ...NUEVA, version: 'v99' }],
    ['el autor (sale del token)', { ...NUEVA, actualizadaPor: randomUUID() }],
    ['un importe fraccionario', { ...NUEVA, bajadaCentavos: 150_000.5 }],
    ['un importe negativo', { ...NUEVA, centavosPorKm: -1 }],
    ['un importe sobre el tope', { ...NUEVA, minimoCentavos: TOPE_IMPORTE_CENTAVOS + 1 }],
    ['el máximo en cero', { ...NUEVA, maxMetros: 0 }],
    ['el máximo sobre el tope', { ...NUEVA, maxMetros: TOPE_MAX_METROS + 1 }],
    ['un número como texto', { ...NUEVA, centavosPorMinuto: '10000' }],
    ['un campo que falta', { bajadaCentavos: 1, centavosPorKm: 1, centavosPorMinuto: 1, minimoCentavos: 1 }],
    ['un null', { ...NUEVA, maxMetros: null }],
  ])('%s → 400 y no crea versión', async (_caso, cuerpo) => {
    await ver();
    const res = await configurar(cuerpo);
    expect(res.status).toBe(400);
    expect(await versiones()).toBe(1);
    expect(await cambios()).toBe(1);
  });

  it('en el tope exacto se acepta', async () => {
    const tope = {
      bajadaCentavos: TOPE_IMPORTE_CENTAVOS,
      centavosPorKm: 0,
      centavosPorMinuto: 0,
      minimoCentavos: 0,
      maxMetros: TOPE_MAX_METROS,
    };
    const res = await configurar(tope);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(tope);
  });

  it('un pedido rechazado por validación no ocupa la clave', async () => {
    const encabezados = clave();
    const admin = randomUUID();
    expect((await configurar({ ...NUEVA, bajadaCentavos: -1 }, encabezados, admin)).status).toBe(400);
    expect((await configurar(NUEVA, encabezados, admin)).status).toBe(200);
  });
});

describe('Idempotency-Key en el PUT', () => {
  it('el reintento con la misma clave y el mismo cuerpo devuelve la respuesta original sin crear otra versión', async () => {
    const encabezados = clave();
    const admin = randomUUID();
    const primera = await configurar(NUEVA, encabezados, admin);
    const segunda = await configurar(NUEVA, encabezados, admin);

    expect(primera.status).toBe(200);
    expect(segunda.status).toBe(200);
    expect(segunda.headers['idempotent-replayed']).toBe('true');
    expect(segunda.text).toBe(primera.text);
    // En Postgres: semilla + una sola versión nueva, una sola auditoría nueva, un solo registro de la clave.
    expect(await versiones()).toBe(2);
    expect(await cambios()).toBe(2);
    expect(await registrosIdempotencia()).toBe(1);
  });

  it('la misma clave con otro cuerpo → 422 y no crea versión', async () => {
    const encabezados = clave();
    const admin = randomUUID();
    expect((await configurar(NUEVA, encabezados, admin)).status).toBe(200);
    const res = await configurar({ ...NUEVA, bajadaCentavos: 1 }, encabezados, admin);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CLAVE_IDEMPOTENCIA_REUTILIZADA');
    expect(await versiones()).toBe(2);
    expect((await ver()).body.bajadaCentavos).toBe(NUEVA.bajadaCentavos);
  });

  it('Redis de idempotencia caído → 503 y no se procesa (falla cerrado)', async () => {
    const caido = await levantarDispatch({
      idempotencia: ({ almacen }) => ({
        almacen,
        cerrojo: { tomar: () => Promise.reject(new Error('ECONNREFUSED')), soltar: () => Promise.resolve() },
      }),
    });
    try {
      await ver();
      const res = await request(caido.url).put('/admin/tarifas').set(clave()).set(await caido.auth(randomUUID(), 'admin')).send(NUEVA);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('IDEMPOTENCIA_NO_DISPONIBLE');
      expect(await versiones()).toBe(1);
    } finally {
      await caido.cerrar();
    }
  });
});

describe('la garantía la da Postgres', () => {
  it('con el cerrojo vencido y sin ver el registro previo, la clave guardada en la transacción impide otra versión', async () => {
    // El peor caso: Redis ya no protege y la búsqueda previa del middleware no ve el registro.
    const sinRedis = await levantarDispatch({
      idempotencia: ({ almacen }) => ({
        almacen: { buscar: () => Promise.resolve(null), guardar: (r) => almacen.guardar(r) },
        cerrojo: { tomar: () => Promise.resolve(randomUUID()), soltar: () => Promise.resolve() },
      }),
    });
    try {
      const encabezados = clave();
      const auth = await sinRedis.auth(randomUUID(), 'admin');
      const primera = await request(sinRedis.url).put('/admin/tarifas').set(encabezados).set(auth).send(NUEVA);
      const segunda = await request(sinRedis.url).put('/admin/tarifas').set(encabezados).set(auth).send(NUEVA);
      expect(primera.status).toBe(200);
      expect(segunda.status).toBe(409);
      expect(segunda.body.error.code).toBe('CLAVE_IDEMPOTENCIA_EN_CURSO');
      expect(await versiones()).toBe(2);
      expect(await cambios()).toBe(2);
    } finally {
      await sinRedis.cerrar();
    }
  });
});

describe('rollback', () => {
  it('si algo falla antes del COMMIT, no queda versión, ni auditoría, ni la clave: el reintento se procesa', async () => {
    const falla = await levantarDispatch({
      tarifas: { repo: { dentroDelCambio: () => Promise.reject(new Error('falla a propósito')) } },
    });
    try {
      await ver();
      const encabezados = clave();
      const admin = randomUUID();
      const res = await request(falla.url).put('/admin/tarifas').set(encabezados).set(await falla.auth(admin, 'admin')).send(NUEVA);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('a propósito');

      expect(await versiones()).toBe(1);
      expect(await cambios()).toBe(1);
      expect(await registrosIdempotencia()).toBe(0);
      expect((await ver()).body.version).toBe('v1');

      // La misma clave, ya sin la falla: se procesa (no quedó ocupada por el intento que se deshizo).
      const reintento = await configurar(NUEVA, encabezados, admin);
      expect(reintento.status).toBe(200);
      expect(reintento.headers['idempotent-replayed']).toBeUndefined();
      expect(reintento.body.version).toBe('v2');
    } finally {
      await falla.cerrar();
    }
  });
});
