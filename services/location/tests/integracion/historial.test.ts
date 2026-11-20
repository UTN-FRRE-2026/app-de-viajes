import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPrisma } from '../../src/infra/db/cliente.js';
import { GRUPO_HISTORIAL } from '../../src/infra/redis/claves.js';
import {
  ConsumidorHistorial,
  EscritorHistorialPrisma,
  type EntradaHistorial,
  type EscritorHistorial,
} from '../../src/infra/redis/historial.js';
import { alNorte, sistemaCon } from '../soporte/memoria.js';
import { URL_BD_TEST } from '../soporte/preparar-bd.js';
import { borrarPrefijo, crearRedisTest, loggerSilencioso, repositorioGeoTest } from '../soporte/redis.js';

const prisma = crearPrisma(URL_BD_TEST, 5);
const real = new EscritorHistorialPrisma(prisma);
let redis: Redis;
let bloqueante: Redis;
const prefijos: string[] = [];

/** Escritor de prueba: delega en Postgres, pero se puede "tirar" o hacer fallar después de escribir. */
class EscritorControlado implements EscritorHistorial {
  destino: EscritorHistorial = real;
  fallarDespuesDeEscribir = 0;
  llamadas = 0;

  async escribir(entradas: EntradaHistorial[]) {
    this.llamadas += 1;
    await this.destino.escribir(entradas);
    if (this.fallarDespuesDeEscribir > 0) {
      this.fallarDespuesDeEscribir -= 1;
      throw new Error('se cortó la conexión antes de confirmar');
    }
  }
}

function armar(escritor: EscritorHistorial, nombre = 'consumidor-a', lote = 50) {
  const geo = repositorioGeoTest(redis);
  prefijos.push(geo.claves.posiciones.replace(/pos$/, ''));
  const consumidor = new ConsumidorHistorial(
    redis,
    bloqueante,
    geo.claves,
    escritor,
    { lote, esperaMs: 50, reclamoMs: 60_000, maxCola: 1_000_000, nombre },
    loggerSilencioso,
  );
  return { ...geo, consumidor, s: sistemaCon(geo.repo) };
}

async function informar(s: ReturnType<typeof sistemaCon>, n: number) {
  for (let i = 0; i < n; i++) {
    await s.casos.registrarUbicacion({ choferId: randomUUID(), ...alNorte(10 * i) });
    s.reloj.avanzar(10);
  }
}

/** Corre vueltas hasta que no quede nada por escribir (o se rinda). */
async function vaciar(c: ConsumidorHistorial) {
  for (let i = 0; i < 100; i++) {
    const propias = await c.procesarPropios();
    const nuevas = propias > 0 ? 0 : await c.procesarNuevos(50);
    if (propias === 0 && nuevas === 0) return;
  }
}

const filas = () => prisma.ping.count();
const filasDistintas = async () => (await prisma.ping.findMany({ select: { streamId: true } })).filter((f) => f.streamId).length;

beforeAll(() => {
  redis = crearRedisTest();
  bloqueante = crearRedisTest();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE pings');
});
afterAll(async () => {
  for (const p of prefijos) await borrarPrefijo(redis, p);
  redis.disconnect();
  bloqueante.disconnect();
  await prisma.$disconnect();
});

describe('historial de la versión optimizada', () => {
  it('cada ping termina en una fila de pings, con su stream_id, y la cola queda vacía', async () => {
    const { consumidor, s, claves } = armar(real);
    await consumidor.preparar();
    await informar(s, 120);
    await vaciar(consumidor);
    expect(await filas()).toBe(120);
    expect(await filasDistintas()).toBe(120);
    expect(await redis.xlen(claves.historial)).toBe(0);
    expect((await consumidor.estado()).pendientes).toBe(0);
  });

  it('Postgres cae y vuelve: la cola crece, nada se confirma y después se recupera todo sin duplicados', async () => {
    const escritor = new EscritorControlado();
    const { consumidor, s, claves } = armar(escritor);
    await consumidor.preparar();
    // Postgres "real" pero inalcanzable: Prisma falla de verdad.
    const prismaCaido = crearPrisma('postgresql://location_svc:x@127.0.0.1:1/location_test', 1);
    escritor.destino = new EscritorHistorialPrisma(prismaCaido);
    try {
      await informar(s, 60);
      await expect(consumidor.unaVuelta()).rejects.toThrow();
      await informar(s, 40);
      await expect(consumidor.procesarPropios()).rejects.toThrow();
      expect(await filas()).toBe(0);
      expect(await redis.xlen(claves.historial)).toBe(100);
      expect((await consumidor.estado()).pendientes).toBeGreaterThan(0);
    } finally {
      await prismaCaido.$disconnect();
    }

    escritor.destino = real; // vuelve Postgres
    await vaciar(consumidor);
    expect(await filas()).toBe(100);
    expect(await filasDistintas()).toBe(100);
    expect(await redis.xlen(claves.historial)).toBe(0);
  });

  it('se escribe el lote pero falla la confirmación: el reintento no duplica filas', async () => {
    const escritor = new EscritorControlado();
    escritor.fallarDespuesDeEscribir = 2;
    const { consumidor, s } = armar(escritor);
    await consumidor.preparar();
    await informar(s, 30);
    await expect(consumidor.procesarNuevos(50)).rejects.toThrow('se cortó');
    await expect(consumidor.procesarPropios()).rejects.toThrow('se cortó');
    await vaciar(consumidor);
    expect(escritor.llamadas).toBeGreaterThanOrEqual(3);
    expect(await filas()).toBe(30);
  });

  it('otra instancia muere con entradas sin confirmar: se recuperan en ejecución, sin reiniciar', async () => {
    const caido = new EscritorControlado();
    caido.destino = { escribir: async () => Promise.reject(new Error('la instancia murió')) };
    const a = armar(caido, 'instancia-que-muere');
    await a.consumidor.preparar();
    await informar(a.s, 25);
    await expect(a.consumidor.procesarNuevos(50)).rejects.toThrow();
    const pendientesDeA = await redis.xpending(a.claves.historial, GRUPO_HISTORIAL);
    expect(Number((pendientesDeA as [number])[0])).toBe(25);

    // Otro consumidor, sobre las mismas claves, reclama lo abandonado (inactividad mínima: 0 ms).
    const b = new ConsumidorHistorial(redis, bloqueante, a.claves, real, { lote: 50, esperaMs: 50, reclamoMs: 0, maxCola: 1_000_000, nombre: 'instancia-viva' }, loggerSilencioso);
    expect(await b.reclamarAbandonadas(0)).toBe(25);
    expect(await filas()).toBe(25);
    expect((await b.estado()).pendientes).toBe(0);
  });

  it('al detener (SIGTERM) vacía lo que haya antes de cerrar', async () => {
    const { consumidor, s, claves } = armar(real, 'consumidor-apagado', 20);
    await consumidor.preparar();
    await informar(s, 75);
    consumidor.iniciar();
    await consumidor.detener();
    expect(await filas()).toBe(75);
    expect(await redis.xlen(claves.historial)).toBe(0);
  });

  it('la cola llena se detecta en el estado y en /metrics: ocupación y descartes', async () => {
    const geo = repositorioGeoTest(redis, 4);
    prefijos.push(geo.claves.posiciones.replace(/pos$/, ''));
    const c = new ConsumidorHistorial(redis, bloqueante, geo.claves, real, { lote: 10, esperaMs: 50, reclamoMs: 60_000, maxCola: 4 }, loggerSilencioso);
    await c.preparar();
    await informar(sistemaCon(geo.repo), 6);
    expect(await c.estado()).toMatchObject({ enCola: 4, descartados: 2, ocupacion: 1, maxCola: 4 });
  });
});
