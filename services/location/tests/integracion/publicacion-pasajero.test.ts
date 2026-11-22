import { randomUUID } from 'node:crypto';
import { canalPosicionChofer, canalPosicionPasajero, PosicionChoferPublicada, PosicionPasajeroPublicada } from '@viajes/contracts';
import type { Rol } from '@viajes/platform';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearRedisPublicador, PublicadorPosicionesRedis } from '../../src/infra/redis/publicador-posiciones.js';
import { alNorte, OBELISCO, VIGENCIA_MS } from '../soporte/memoria.js';
import { crearProxyRedis } from '../soporte/proxy-tcp.js';
import { borrarPrefijo, crearRedisTest, escucharCanal, loggerSilencioso, prefijoUnico } from '../soporte/redis.js';
import { levantarLocation, type Location } from '../soporte/sistema.js';

/**
 * `POST /ubicaciones/pasajero`: la posición del pasajero, para el seguimiento del chofer asignado.
 * Pruebas enfocadas en tres cosas: permisos e id del token; se publica en el canal del pasajero sin
 * guardarse ni entrar en la búsqueda de candidatos; 503 si Redis falla. El orden (la marca del Lua) es
 * el mismo script que el del chofer y lo cubren sus pruebas (tests/integracion/publicacion.test.ts).
 */
let redis: Redis;
const prefijos: string[] = [];

beforeAll(() => {
  redis = crearRedisTest();
});
afterAll(async () => {
  for (const p of prefijos) await borrarPrefijo(redis, p);
  redis.disconnect();
});

const metrica = async (d: Location, resultado: string) => {
  const res = await request(d.url).get('/metrics').set(d.conMetricas);
  const m = res.text.match(new RegExp(`location_posiciones_publicadas_total\\{de="pasajero",resultado="${resultado}",servicio="location"\\} (\\d+)`));
  return Number(m?.[1]);
};

const informar = async (d: Location, sub: string, rol: Rol, cuerpo: object = OBELISCO) =>
  request(d.url).post('/ubicaciones/pasajero').set(await d.auth(sub, rol)).send(cuerpo);

describe.each(['ingenua', 'optimizada'] as const)('posición del pasajero (%s)', (estrategia) => {
  let d: Location;
  let prefijo: string;
  beforeAll(async () => {
    prefijo = prefijoUnico();
    prefijos.push(prefijo);
    d = await levantarLocation({}, { UBICACION_ESTRATEGIA: estrategia, LOCATION_REDIS_PREFIJO: prefijo });
  });
  afterAll(async () => {
    await d.cerrar();
  });
  beforeEach(async () => {
    await d.limpiar();
  });

  describe('permisos e id del token', () => {
    it('sin token 401; chofer, operador, admin y admin_flota 403', async () => {
      expect((await request(d.url).post('/ubicaciones/pasajero').send(OBELISCO)).status).toBe(401);
      for (const rol of ['chofer', 'operador', 'admin', 'admin_flota'] as const) {
        const res = await informar(d, randomUUID(), rol);
        expect(res.status, rol).toBe(403);
        expect(res.body.error.code).toBe('ROL_NO_PERMITIDO');
      }
    });

    it('un id en el cuerpo se rechaza (400): el pasajero sale del token', async () => {
      for (const extra of [{ pasajeroId: randomUUID() }, { choferId: randomUUID() }]) {
        const res = await informar(d, randomUUID(), 'pasajero', { ...OBELISCO, ...extra });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDACION');
      }
    });

    it('un pasajero no puede usar la ruta del chofer (403)', async () => {
      const res = await request(d.url).post('/ubicaciones').set(await d.auth(randomUUID(), 'pasajero')).send(OBELISCO);
      expect(res.status).toBe(403);
    });
  });

  describe('se publica en el canal del pasajero, sin guardarse ni entrar en candidatos', () => {
    it('llega a su canal con el contrato y el id del token; ni su canal de chofer ni el de otro pasajero reciben nada', async () => {
      const pasajero = randomUUID();
      const propio = await escucharCanal(redis, canalPosicionPasajero(prefijo, pasajero));
      const comoChofer = await escucharCanal(redis, canalPosicionChofer(prefijo, pasajero));
      const otro = await escucharCanal(redis, canalPosicionPasajero(prefijo, randomUUID()));
      try {
        const antes = Date.now();
        expect((await informar(d, pasajero, 'pasajero', alNorte(200))).status).toBe(204);

        const [mensaje, ...resto] = await propio.hasta();
        expect(resto).toEqual([]);
        const posicion = PosicionPasajeroPublicada.parse(mensaje);
        expect(posicion).toMatchObject({ tipo: 'PassengerLocationUpdated', pasajeroId: pasajero, ...alNorte(200) });
        expect(Date.parse(posicion.actualizadaEn)).toBeGreaterThanOrEqual(antes);
        // El payload del pasajero no pasa el contrato del chofer: no se confunde aunque llegue al canal equivocado.
        expect(PosicionChoferPublicada.safeParse(mensaje).success).toBe(false);
        expect(await comoChofer.hasta()).toEqual([]);
        expect(await otro.hasta()).toEqual([]);
        expect(await metrica(d, 'publicada')).toBe(1);
      } finally {
        propio.cerrar();
        comoChofer.cerrar();
        otro.cerrar();
      }
    });

    it('no se guarda ni aparece en la búsqueda de candidatos', async () => {
      const pasajero = randomUUID();
      for (const metros of [50, 100, 150]) expect((await informar(d, pasajero, 'pasajero', alNorte(metros))).status).toBe(204);

      const candidatos = await request(d.url)
        .get('/interno/candidatos')
        .query({ lat: OBELISCO.lat, lng: OBELISCO.lng, radioMetros: 5000 })
        .set(d.servicio)
        .expect(200);
      expect(candidatos.body.candidatos).toEqual([]);
      // Ni el historial (ingenua) ni las estructuras de Redis (optimizada) tienen al pasajero.
      expect(await d.prisma.ping.count()).toBe(0);
      expect(await redis.hexists(`${prefijo}pos`, pasajero)).toBe(0);
      expect(await redis.zscore(`${prefijo}visto`, pasajero)).toBeNull();
      expect(await redis.zscore(`${prefijo}geo`, pasajero)).toBeNull();
      expect(await redis.exists(`${prefijo}historial`)).toBe(0);
      // Lo único que queda es la marca de orden, y vence sola.
      const ttl = await redis.pttl(`${prefijo}publicada-pasajero:${pasajero}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(2 * VIGENCIA_MS);
    });
  });
});

describe('503 si falla Redis', () => {
  let proxy: Awaited<ReturnType<typeof crearProxyRedis>>;
  let d: Location;
  let prefijo: string;
  let conexion: Redis;

  beforeEach(async () => {
    prefijo = prefijoUnico();
    prefijos.push(prefijo);
    proxy = await crearProxyRedis();
    conexion = crearRedisPublicador(proxy.url, loggerSilencioso);
    const publicador = new PublicadorPosicionesRedis(conexion, { prefijo, marcaMs: 2 * VIGENCIA_MS });
    await publicador.listo();
    d = await levantarLocation({ publicador }, { UBICACION_ESTRATEGIA: 'optimizada', LOCATION_REDIS_PREFIJO: prefijo });
  });
  afterEach(async () => {
    conexion.disconnect();
    await proxy.cerrar();
    await d.cerrar();
  });

  it('con el Redis del publicador caído responde 503 POSICION_NO_PUBLICADA y cuenta el error', async () => {
    proxy.estado.rechazar = true;
    proxy.cortar();
    await expect.poll(() => conexion.status, { timeout: 2000 }).not.toBe('ready');

    const res = await informar(d, randomUUID(), 'pasajero');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('POSICION_NO_PUBLICADA');
    expect(await metrica(d, 'error')).toBe(1);
  });

  it('sin confirmación en 200 ms también es 503', async () => {
    proxy.estado.congelarRespuestas = true;
    const res = await informar(d, randomUUID(), 'pasajero');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('POSICION_NO_PUBLICADA');
  });
});

describe('sin publicador (sin Redis)', () => {
  it('503: no hay dónde publicar', async () => {
    const d = await levantarLocation({ publicador: null }, { LOCATION_REDIS_PREFIJO: prefijoUnico() });
    try {
      const res = await informar(d, randomUUID(), 'pasajero');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('POSICION_NO_PUBLICADA');
    } finally {
      await d.cerrar();
    }
  });
});
