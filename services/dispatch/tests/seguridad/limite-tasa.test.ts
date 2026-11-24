import { randomUUID } from 'node:crypto';
import {
  contadorTasaMemoria,
  contadorTasaRedis,
  crearApp,
  crearLogger,
  limitarTasa,
  type ContadorTasa,
  type Usuario,
} from '@viajes/platform';
import { Router } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clave, DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';

const silencio = crearLogger('limite-test', 'silent');

/** Una app mínima con el límite en una ruta. El usuario sale de un encabezado, en vez de un token. */
function appCon(contador: ContadorTasa, maximo: number) {
  const r = Router();
  r.use((req, _res, next) => {
    const id = req.header('x-usuario');
    if (id) req.usuario = { id, rol: 'pasajero' } satisfies Usuario;
    next();
  });
  r.post('/accion', limitarTasa({ contador, nombre: 'prueba', maximo, ventanaMs: 60_000, logger: silencio }), (_req, res) => {
    res.status(204).end();
  });
  return crearApp({ logger: silencio, rutas: r, chequeos: [], logPedidos: false });
}

describe('limitarTasa (unidad)', () => {
  it('deja pasar hasta el máximo y después 429 con RateLimit-* y Retry-After', async () => {
    const app = appCon(contadorTasaMemoria(), 3);
    const estados: number[] = [];
    let ultima: request.Response | undefined;
    for (let i = 0; i < 4; i++) {
      ultima = await request(app).post('/accion').set('x-usuario', 'ana');
      estados.push(ultima.status);
    }
    expect(estados).toEqual([204, 204, 204, 429]);
    expect(ultima?.body).toEqual({
      error: { code: 'DEMASIADOS_PEDIDOS', message: expect.any(String), requestId: expect.any(String) },
    });
    expect(ultima?.headers['ratelimit-limit']).toBe('3');
    expect(ultima?.headers['ratelimit-remaining']).toBe('0');
    expect(Number(ultima?.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(ultima?.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  it('cada usuario tiene su cuenta', async () => {
    const app = appCon(contadorTasaMemoria(), 1);
    expect((await request(app).post('/accion').set('x-usuario', 'ana')).status).toBe(204);
    expect((await request(app).post('/accion').set('x-usuario', 'ana')).status).toBe(429);
    expect((await request(app).post('/accion').set('x-usuario', 'beto')).status).toBe(204);
  });

  it('la ventana se reinicia al vencer', async () => {
    let t = 0;
    const app = appCon(contadorTasaMemoria(() => t), 1);
    expect((await request(app).post('/accion').set('x-usuario', 'ana')).status).toBe(204);
    expect((await request(app).post('/accion').set('x-usuario', 'ana')).status).toBe(429);
    t = 60_000;
    expect((await request(app).post('/accion').set('x-usuario', 'ana')).status).toBe(204);
  });

  it('máximo 0 desactiva el límite (entorno de carga)', async () => {
    const app = appCon(contadorTasaMemoria(), 0);
    for (let i = 0; i < 5; i++) expect((await request(app).post('/accion').set('x-usuario', 'ana')).status).toBe(204);
  });

  it('falla abierto: si el contador no responde, el pedido pasa', async () => {
    const roto: ContadorTasa = { contar: () => Promise.reject(new Error('redis caído')) };
    const res = await request(appCon(roto, 1)).post('/accion').set('x-usuario', 'ana');
    expect(res.status).toBe(204);
    expect(res.headers['ratelimit-limit']).toBeUndefined();
  });

  it('el mapa en memoria borra las ventanas vencidas al llegar al tope de claves', async () => {
    let t = 0;
    const contador = contadorTasaMemoria(() => t, 2);
    await contador.contar('a', 1000);
    await contador.contar('b', 1000);
    t = 2000;
    // Al pasar el tope se barren las vencidas: «a» vuelve a empezar de cero.
    await contador.contar('c', 1000);
    expect((await contador.contar('a', 1000)).cuenta).toBe(1);
  });
});

describe('POST /solicitudes con límite (dispatch completo, contra Postgres)', () => {
  let d: Awaited<ReturnType<typeof levantarDispatch>>;

  beforeAll(async () => {
    d = await levantarDispatch({ extra: { LIMITE_SOLICITUDES_POR_MINUTO: '2' } });
  });
  afterAll(async () => {
    await d.cerrar();
  });
  beforeEach(async () => {
    await d.limpiar();
  });

  /** Pide un viaje con una clave nueva y lo cancela, para que el pasajero pueda pedir otro. */
  async function pedirYCancelar(auth: Record<string, string>) {
    d.buscador.choferes = [randomUUID()];
    const res = await request(d.url).post('/solicitudes').set(clave()).set(auth).send({ origen: ORIGEN, destino: DESTINO });
    if (res.status === 201) await request(d.url).post(`/solicitudes/${res.body.id}/cancelar`).set(clave()).set(auth).send({});
    return res;
  }

  it('el tercer viaje en el minuto → 429, sin crear nada', async () => {
    const auth = await d.auth(randomUUID(), 'pasajero');
    expect((await pedirYCancelar(auth)).status).toBe(201);
    expect((await pedirYCancelar(auth)).status).toBe(201);
    const res = await pedirYCancelar(auth);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('DEMASIADOS_PEDIDOS');
    expect(res.headers['retry-after']).toBeDefined();
    expect(await d.prisma.solicitudViaje.count()).toBe(2);
  });

  it('reintentar con la misma Idempotency-Key no gasta cupo: devuelve lo guardado', async () => {
    const auth = await d.auth(randomUUID(), 'pasajero');
    d.buscador.choferes = [randomUUID()];
    const misma = clave();
    const cuerpo = { origen: ORIGEN, destino: DESTINO };
    const primera = await request(d.url).post('/solicitudes').set(misma).set(auth).send(cuerpo);
    expect(primera.status).toBe(201);
    for (let i = 0; i < 3; i++) {
      const otra = await request(d.url).post('/solicitudes').set(misma).set(auth).send(cuerpo);
      expect(otra.status).toBe(201);
      expect(otra.headers['idempotent-replayed']).toBe('true');
      expect(otra.body.id).toBe(primera.body.id);
    }
    // Se gastó uno solo: el segundo viaje (con otra clave) todavía entra.
    await request(d.url).post(`/solicitudes/${primera.body.id}/cancelar`).set(clave()).set(auth).send({});
    expect((await pedirYCancelar(auth)).status).toBe(201);
  });

  it('un 429 no queda guardado con la clave: el reintento vuelve a pasar por el límite', async () => {
    const local = await levantarDispatch({ extra: { LIMITE_SOLICITUDES_POR_MINUTO: '1' } });
    try {
      const auth = await local.auth(randomUUID(), 'pasajero');
      local.buscador.choferes = [randomUUID()];
      const primera = await request(local.url).post('/solicitudes').set(clave()).set(auth).send({ origen: ORIGEN, destino: DESTINO });
      expect(primera.status).toBe(201);
      await request(local.url).post(`/solicitudes/${primera.body.id}/cancelar`).set(clave()).set(auth).send({});
      const misma = clave();
      const rechazada = await request(local.url).post('/solicitudes').set(misma).set(auth).send({ origen: ORIGEN, destino: DESTINO });
      expect(rechazada.status).toBe(429);
      // La clave no quedó tomada ni guardada con el 429: el reintento vuelve a pasar por el límite.
      const reintento = await request(local.url).post('/solicitudes').set(misma).set(auth).send({ origen: ORIGEN, destino: DESTINO });
      expect(reintento.status).toBe(429);
      expect(reintento.headers['idempotent-replayed']).toBeUndefined();
      expect(await local.prisma.solicitudViaje.count()).toBe(1);
    } finally {
      await local.cerrar();
    }
  });
});

describe('contadorTasaRedis', () => {
  let d: Awaited<ReturnType<typeof levantarDispatch>>;

  beforeAll(async () => {
    d = await levantarDispatch();
  });
  afterAll(async () => {
    await d.cerrar();
  });

  it('50 pedidos simultáneos de la misma clave: cuentas 1 a 50, sin repetidas, y la clave vence', async () => {
    const prefijo = `dispatch-test:tasa:${randomUUID()}:`;
    const contador = contadorTasaRedis(d.redis, prefijo);
    const estados = await Promise.all(Array.from({ length: 50 }, () => contador.contar('ana', 60_000)));
    expect(estados.map((e) => e.cuenta).sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    for (const e of estados) {
      expect(e.reinicioMs).toBeGreaterThan(0);
      expect(e.reinicioMs).toBeLessThanOrEqual(60_000);
    }
    const ttl = await d.redis.pttl(`${prefijo}ana`);
    expect(ttl).toBeGreaterThan(0);
    await d.redis.del(`${prefijo}ana`);
  });

  it('el vencimiento se fija una sola vez: los pedidos siguientes no lo alargan', async () => {
    const prefijo = `dispatch-test:tasa:${randomUUID()}:`;
    const contador = contadorTasaRedis(d.redis, prefijo);
    await contador.contar('beto', 1000);
    await new Promise((r) => setTimeout(r, 300));
    const segundo = await contador.contar('beto', 1000);
    expect(segundo.cuenta).toBe(2);
    expect(segundo.reinicioMs).toBeLessThanOrEqual(750);
    await d.redis.del(`${prefijo}beto`);
  });
});
