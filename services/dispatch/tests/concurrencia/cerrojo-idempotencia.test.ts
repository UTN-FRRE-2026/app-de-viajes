import { randomUUID } from 'node:crypto';
import { cerrojoRedis } from '@viajes/platform';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';

/**
 * ADR 0012, fila 25: un pedido no suelta el cerrojo de idempotencia que ya tomó otro.
 *
 * El cerrojo en vuelo es `SET NX PX` con un token aleatorio. Si un pedido tarda más que el TTL, el
 * cerrojo vence y lo toma un segundo pedido con la misma clave. Cuando el primero termina, suelta «su»
 * cerrojo: si lo hiciera con un DEL a secas, borraría el del segundo y un tercer duplicado entraría
 * mientras el segundo sigue en curso.
 *
 * Lo que lo hace pasar: el script Lua `SOLTAR` de `packages/platform/src/idempotencia.ts`, que compara el
 * token y borra en un solo paso (atómico en Redis): el token viejo ya no coincide y no borra nada.
 */
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

let d: Awaited<ReturnType<typeof levantarDispatch>>;
/** Cuántas veces se tomó el cerrojo, y el TTL de las próximas tomas (las que falten usan el de la config). */
const cerrojo = { tomas: 0, ttls: [] as number[] };
const DEMORA_MS = 600;

beforeAll(async () => {
  d = await levantarDispatch({
    // Cada pedido queda DEMORA_MS dentro de la transacción, con la solicitud bloqueada.
    demoraTrasLeerMs: DEMORA_MS,
    idempotencia: (reales) => ({
      almacen: reales.almacen,
      cerrojo: {
        async tomar(nombre, ttlMs) {
          const token = await reales.cerrojo.tomar(nombre, cerrojo.ttls.shift() ?? ttlMs);
          if (token) cerrojo.tomas++;
          return token;
        },
        soltar: (nombre, token) => reales.cerrojo.soltar(nombre, token),
      },
    }),
  });
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
  Object.assign(cerrojo, { tomas: 0, ttls: [] });
});

describe('el cerrojo de idempotencia en Redis (cerrojoRedis)', () => {
  it('quien tenía un cerrojo vencido no suelta el que tomó otro pedido', async () => {
    const c = cerrojoRedis(d.redis, `dispatch-test:cerrojo:${randomUUID()}:`);
    const nombre = 'usuario:clave';

    const viejo = await c.tomar(nombre, 100);
    expect(viejo).not.toBeNull();
    await esperar(150);
    // Venció: lo toma otro pedido con la misma clave.
    const nuevo = await c.tomar(nombre, 30_000);
    expect(nuevo).not.toBeNull();

    // El primero termina y suelta con su token viejo, a la vez que llegan 10 duplicados.
    const [, ...duplicados] = await Promise.all([c.soltar(nombre, viejo!), ...Array.from({ length: 10 }, () => c.tomar(nombre, 30_000))]);

    // Ningún duplicado entra: el cerrojo sigue siendo del segundo.
    expect(duplicados.every((t) => t === null)).toBe(true);
    expect(await c.tomar(nombre, 30_000)).toBeNull();

    // El dueño sí lo suelta, y recién ahí se puede volver a tomar.
    await c.soltar(nombre, nuevo!);
    expect(await c.tomar(nombre, 30_000)).not.toBeNull();
  });
});

describe('tres pedidos con la misma Idempotency-Key, y el cerrojo del primero vence en vuelo', () => {
  it('el primero, al terminar, no suelta el cerrojo del segundo: el tercero recibe 409 CLAVE_IDEMPOTENCIA_EN_CURSO', async () => {
    // Una solicitud BUSCANDO. Los tres pedidos son «en camino» de un chofer que no es el asignado: cada uno
    // bloquea la solicitud, espera DEMORA_MS y termina en 404, así que no se registra ninguna respuesta
    // (un error no tuvo efecto) y el tercero no puede contestarse desde Postgres: solo lo frena el cerrojo.
    d.buscador.choferes = [randomUUID()];
    const creada = await request(d.url)
      .post('/solicitudes')
      .set({ 'Idempotency-Key': randomUUID() })
      .set(await d.auth(randomUUID(), 'pasajero'))
      .send({ origen: ORIGEN, destino: DESTINO });
    expect(creada.status).toBe(201);
    cerrojo.tomas = 0;

    const chofer = randomUUID();
    const comoChofer = await d.auth(chofer, 'chofer');
    const clave = randomUUID();
    // `.then` manda el pedido ya: supertest no lo envía hasta que alguien lo espera.
    const enCamino = () =>
      request(d.url)
        .post(`/solicitudes/${creada.body.id}/en-camino`)
        .set({ 'Idempotency-Key': clave })
        .set(comoChofer)
        .send({})
        .then((r) => r);

    // El primero toma el cerrojo por 200 ms: vence mucho antes de que termine (DEMORA_MS).
    cerrojo.ttls.push(200);
    const primero = enCamino();
    await esperar(300);
    // El segundo encuentra el cerrojo vencido, lo toma (por 30 s) y queda esperando el lock de la solicitud.
    const segundo = enCamino();
    // El primero termina hacia los 600 ms y suelta con su token. El tercero llega después, con el segundo en curso.
    const r1 = await primero;
    await esperar(100);
    const r3 = await enCamino();
    const r2 = await segundo;

    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    expect(r3.status).toBe(409);
    expect(r3.body.error.code).toBe('CLAVE_IDEMPOTENCIA_EN_CURSO');
    // Solo el primero y el segundo tomaron el cerrojo y llegaron al caso de uso.
    expect(cerrojo.tomas).toBe(2);
    // Y nada quedó registrado: ninguno tuvo efecto. El segundo soltó su propio cerrojo.
    expect(await d.prisma.registroIdempotencia.count()).toBe(1); // la creación de la solicitud
    await esperar(100); // el cerrojo se suelta al cerrarse la respuesta, un instante después
    expect(await d.redis.exists(`dispatch:idempotencia:${chofer}:${clave}`)).toBe(0);
  });
});
