import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crearLogger, middlewareErrores, type Usuario } from '@viajes/platform';
import express from 'express';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BusEventosMemoria } from '../../src/infra/tiempo-real/bus-memoria.js';
import { cupoConexionesRedis, type CupoConexiones } from '../../src/infra/tiempo-real/cupo-conexiones.js';
import { StreamsEventos } from '../../src/infra/tiempo-real/sse.js';
import { abrirStream, type StreamDePrueba } from '../soporte/sse.js';
import { URL_REDIS_TEST } from '../soporte/sistema-postgres.js';

/**
 * El límite de streams SSE por usuario, contado entre instancias (ADR 0012): dos «dispatch» con su
 * propio StreamsEventos y el mismo Redis. Sin el cupo compartido, cada uno dejaría abrir 3.
 */
const logger = crearLogger('sse-cupo-test', 'silent');
let redis: Redis;
const servidores: Server[] = [];
const streams: StreamDePrueba[] = [];

beforeAll(() => {
  redis = new Redis(URL_REDIS_TEST, { maxRetriesPerRequest: 1 });
});
afterAll(() => {
  redis.disconnect();
});
afterEach(() => {
  for (const s of streams.splice(0)) s.cerrar();
  for (const s of servidores.splice(0)) s.close();
});

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Una instancia: su propio StreamsEventos (su propia cuenta local) y el cupo dado. */
async function instancia(usuarioId: string, cupo: CupoConexiones | undefined, latidoMs = 15_000) {
  const sse = new StreamsEventos({ bus: new BusEventosMemoria(), historial: { desde: async () => [] }, logger, maxPorUsuario: 3, latidoMs, ...(cupo ? { cupo } : {}) });
  const app = express();
  app.use((req, _res, next) => {
    req.usuario = { id: usuarioId, rol: 'pasajero' } satisfies Usuario;
    next();
  });
  app.get('/eventos', sse.manejador());
  app.use(middlewareErrores(logger));
  const servidor = await new Promise<Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  servidores.push(servidor);
  return async () => {
    const s = await abrirStream(`http://127.0.0.1:${(servidor.address() as AddressInfo).port}/eventos`, {});
    streams.push(s);
    return s;
  };
}

describe('cupo de streams SSE entre instancias', () => {
  it('3 en una instancia: el cuarto, en otra, recibe 429; al cerrar uno, entra', async () => {
    const usuario = randomUUID();
    const cupo = cupoConexionesRedis(redis, `dispatch-test:sse:${randomUUID()}:`);
    const [abrirA, abrirB] = [await instancia(usuario, cupo), await instancia(usuario, cupo)];

    const abiertos = [await abrirA(), await abrirA(), await abrirA()];
    expect(abiertos.map((s) => s.estado)).toEqual([200, 200, 200]);

    const cuarto = await abrirB();
    expect(cuarto.estado).toBe(429);
    expect(JSON.parse(cuarto.cuerpo()).error.code).toBe('DEMASIADAS_CONEXIONES');

    abiertos[0]?.cerrar();
    // El cierre suelta el lugar en Redis apenas el servidor ve el `close`.
    let otro: StreamDePrueba | undefined;
    for (let i = 0; i < 40 && otro?.estado !== 200; i++) {
      await dormir(25);
      otro = await abrirB();
    }
    expect(otro?.estado).toBe(200);
  });

  it('sin cupo compartido, cada instancia deja abrir 3 (lo que pasaba antes)', async () => {
    const usuario = randomUUID();
    const [abrirA, abrirB] = [await instancia(usuario, undefined), await instancia(usuario, undefined)];
    for (let i = 0; i < 3; i++) expect((await abrirA()).estado).toBe(200);
    expect((await abrirB()).estado).toBe(200);
  });

  it('el lugar de una instancia que murió vence solo; el latido renueva los vivos', async () => {
    const usuario = randomUUID();
    const prefijo = `dispatch-test:sse:${randomUUID()}:`;
    const cupo = cupoConexionesRedis(redis, prefijo);
    // Tres lugares tomados por una instancia que «murió»: nadie los renueva ni los suelta. Vencen a 300 ms.
    for (let i = 0; i < 3; i++) expect(await cupo.tomar(usuario, randomUUID(), 3, 300)).toBe(true);

    // Latido cada 100 ms: su lugar vence a los 300 ms, pero se renueva.
    const abrir = await instancia(usuario, cupo, 100);
    expect((await abrir()).estado).toBe(429);
    await dormir(400);
    const vivo = await abrir();
    expect(vivo.estado).toBe(200);
    await dormir(500);
    // Pasados más de 300 ms, el vivo sigue ocupando su lugar (lo renovó el latido); los muertos, no.
    expect(await redis.zcard(`${prefijo}${usuario}`)).toBe(1);
  });

  it('10 pedidos simultáneos con máximo 3: exactamente 3 lugares', async () => {
    const cupo = cupoConexionesRedis(redis, `dispatch-test:sse:${randomUUID()}:`);
    const usuario = randomUUID();
    const resultados = await Promise.all(Array.from({ length: 10 }, () => cupo.tomar(usuario, randomUUID(), 3, 10_000)));
    expect(resultados.filter(Boolean)).toHaveLength(3);
  });

  it('si el cupo no responde, el stream se abre igual (falla abierto) y queda el límite local', async () => {
    const roto: CupoConexiones = {
      tomar: () => Promise.reject(new Error('redis caído')),
      renovar: () => Promise.resolve(true),
      soltar: () => Promise.resolve(),
    };
    const abrir = await instancia(randomUUID(), roto);
    for (let i = 0; i < 3; i++) expect((await abrir()).estado).toBe(200);
    expect((await abrir()).estado).toBe(429);
  });
});

/** Espera hasta que se cumpla la condición (con un tope), revisando cada 25 ms. */
async function esperarHasta(condicion: () => Promise<boolean>, ms = 2000) {
  const limite = performance.now() + ms;
  while (!(await condicion())) {
    if (performance.now() > limite) throw new Error('no se cumplió la condición a tiempo');
    await dormir(25);
  }
}

describe('cupo compartido: lugares perdidos (Redis caído más que el TTL, o reiniciado sin datos)', () => {
  it('si el lugar desaparece, el latido lo vuelve a tomar y el stream sigue contado', async () => {
    const usuario = randomUUID();
    const prefijo = `dispatch-test:sse:${randomUUID()}:`;
    const abrir = await instancia(usuario, cupoConexionesRedis(redis, prefijo), 50);
    const s = await abrir();
    expect(s.estado).toBe(200);
    expect(await redis.zcard(`${prefijo}${usuario}`)).toBe(1);

    // Como un Redis que se reinició sin datos.
    await redis.del(`${prefijo}${usuario}`);
    await esperarHasta(async () => (await redis.zcard(`${prefijo}${usuario}`)) === 1);
  });

  it('si el lugar desaparece y ya no hay otro (otra instancia ocupó los 3), el stream se cierra', async () => {
    const usuario = randomUUID();
    const prefijo = `dispatch-test:sse:${randomUUID()}:`;
    const abrir = await instancia(usuario, cupoConexionesRedis(redis, prefijo), 50);
    const s = await abrir();
    expect(s.estado).toBe(200);

    // Se pierde su lugar y otra instancia ocupa los 3, de una (MULTI): el latido no se mete en el medio.
    const clave = `${prefijo}${usuario}`;
    const vence = Date.now() + 10_000;
    await redis.multi().del(clave).zadd(clave, vence, 'otra-1', vence, 'otra-2', vence, 'otra-3').pexpire(clave, 10_000).exec();

    // Sin el arreglo, quedaba abierto sin contarse: 4 streams del mismo usuario.
    await Promise.race([s.cerrado, dormir(2000).then(() => Promise.reject(new Error('el stream no se cerró')))]);
    expect(await redis.zcard(`${prefijo}${usuario}`)).toBe(3);
  });

  it('un stream abierto con Redis caído toma su lugar cuando Redis vuelve', async () => {
    const usuario = randomUUID();
    const prefijo = `dispatch-test:sse:${randomUUID()}:`;
    const real = cupoConexionesRedis(redis, prefijo);
    let caido = true;
    const intermitente: CupoConexiones = {
      tomar: (...a) => (caido ? Promise.reject(new Error('redis caído')) : real.tomar(...a)),
      renovar: (...a) => (caido ? Promise.reject(new Error('redis caído')) : real.renovar(...a)),
      soltar: (...a) => real.soltar(...a),
    };
    const abrir = await instancia(usuario, intermitente, 50);
    expect((await abrir()).estado).toBe(200);
    await dormir(150);
    expect(await redis.zcard(`${prefijo}${usuario}`)).toBe(0);

    caido = false;
    await esperarHasta(async () => (await redis.zcard(`${prefijo}${usuario}`)) === 1);
  });

  it('renovar dice si el lugar sigue: true si está, false si se perdió o venció', async () => {
    const usuario = randomUUID();
    const prefijo = `dispatch-test:sse:${randomUUID()}:`;
    const cupo = cupoConexionesRedis(redis, prefijo);
    const id = randomUUID();
    expect(await cupo.tomar(usuario, id, 3, 200)).toBe(true);
    expect(await cupo.renovar(usuario, id, 200)).toBe(true);
    await dormir(300);
    // Vencido: no se revive (pudo dejar de contarse en un tomar de otra instancia).
    expect(await cupo.renovar(usuario, id, 200)).toBe(false);
    expect(await redis.zcard(`${prefijo}${usuario}`)).toBe(0);
  });
});
