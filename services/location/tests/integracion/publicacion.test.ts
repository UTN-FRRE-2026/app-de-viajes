import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as esperar } from 'node:timers/promises';
import { canalPosicionChofer, PosicionChoferPublicada } from '@viajes/contracts';
import { ErrorHttp } from '@viajes/platform';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearCasosDeUso } from '../../src/dominio/casos-uso/index.js';
import type { Ping } from '../../src/dominio/entidades/index.js';
import type { RepositorioUbicaciones, ResultadoPublicacion } from '../../src/dominio/puertos/index.js';
import { crearPrisma } from '../../src/infra/db/cliente.js';
import { RepositorioUbicacionesIngenuo } from '../../src/infra/db/repositorio-ingenuo.js';
import {
  crearRedisPublicador,
  marcaPublicada,
  PublicadorPosicionesRedis,
  TIMEOUT_PUBLICACION_MS,
} from '../../src/infra/redis/publicador-posiciones.js';
import { alNorte, OBELISCO, RelojFalso, VIGENCIA_MS } from '../soporte/memoria.js';
import { URL_BD_TEST } from '../soporte/preparar-bd.js';
import { crearProxyRedis } from '../soporte/proxy-tcp.js';
import {
  borrarPrefijo,
  crearRedisTest,
  escucharCanal,
  loggerSilencioso,
  prefijoUnico,
  repositorioGeoTest,
  URL_REDIS_TEST,
} from '../soporte/redis.js';
import { levantarLocation, type Location } from '../soporte/sistema.js';

/**
 * Posición en vivo contra Redis real: el canal y el payload, el ping atrasado, el vencido y las
 * fallas del publicador (solo el publicador: el Redis que guarda las posiciones sigue andando).
 */
let redis: Redis;
const prisma = crearPrisma(URL_BD_TEST, 5);
const prefijos: string[] = [];
const nuevoPrefijo = () => {
  const p = prefijoUnico();
  prefijos.push(p);
  return p;
};

beforeAll(() => {
  redis = crearRedisTest();
});
afterAll(async () => {
  for (const p of prefijos) await borrarPrefijo(redis, p);
  redis.disconnect();
  await prisma.$disconnect();
});

const mensajeDe = (choferId: string, posicion: { lat: number; lng: number }, en: Date) => ({
  tipo: 'DriverLocationUpdated',
  choferId,
  lat: posicion.lat,
  lng: posicion.lng,
  actualizadaEn: en.toISOString(),
});

const metricaPublicacion = async (d: Location, resultado: ResultadoPublicacion) => {
  const res = await request(d.url).get('/metrics').set(d.conMetricas);
  const m = res.text.match(new RegExp(`location_posiciones_publicadas_total\\{resultado="${resultado}",servicio="location"\\} (\\d+)`));
  return Number(m?.[1]);
};

describe.each(['ingenua', 'optimizada'] as const)('POST /ubicaciones publica la posición (%s)', (estrategia) => {
  let d: Location;
  beforeAll(async () => {
    d = await levantarLocation({}, { UBICACION_ESTRATEGIA: estrategia, LOCATION_REDIS_PREFIJO: nuevoPrefijo() });
    await d.limpiar();
  });
  afterAll(async () => {
    await d.cerrar();
  });

  it('en el canal del chofer del token, con el payload del contrato; el canal de otro no recibe nada', async () => {
    const chofer = randomUUID();
    const otro = randomUUID();
    const prefijo = d.config.LOCATION_REDIS_PREFIJO;
    const canal = await escucharCanal(redis, canalPosicionChofer(prefijo, chofer));
    const ajeno = await escucharCanal(redis, canalPosicionChofer(prefijo, otro));
    try {
      const antes = Date.now();
      await request(d.url).post('/ubicaciones').set(await d.auth(chofer, 'chofer')).send(alNorte(300)).expect(204);
      const despues = Date.now();

      const [mensaje, ...resto] = await canal.hasta();
      expect(resto).toEqual([]);
      const posicion = PosicionChoferPublicada.parse(mensaje);
      expect(posicion).toMatchObject({ tipo: 'DriverLocationUpdated', choferId: chofer, ...alNorte(300) });
      const en = Date.parse(posicion.actualizadaEn);
      expect(en).toBeGreaterThanOrEqual(antes);
      expect(en).toBeLessThanOrEqual(despues);
      expect(await ajeno.hasta()).toEqual([]);
      expect(await metricaPublicacion(d, 'publicada')).toBe(1);
      expect(await metricaPublicacion(d, 'error')).toBe(0);
    } finally {
      canal.cerrar();
      ajeno.cerrar();
    }
  });
});

describe('si el ping no se guarda', () => {
  it('responde el error del guardado y no publica nada', async () => {
    const prefijo = nuevoPrefijo();
    const caido: RepositorioUbicaciones = {
      guardar: () => Promise.reject(new ErrorHttp(503, 'UBICACION_NO_DISPONIBLE', 'no disponible')),
      cercanos: async () => [],
    };
    const d = await levantarLocation({ repo: caido }, { LOCATION_REDIS_PREFIJO: prefijo });
    const chofer = randomUUID();
    const canal = await escucharCanal(redis, canalPosicionChofer(prefijo, chofer));
    try {
      await request(d.url).post('/ubicaciones').set(await d.auth(chofer, 'chofer')).send(OBELISCO).expect(503);
      expect(await canal.hasta()).toEqual([]);
      expect(await redis.exists(marcaPublicada(prefijo, chofer))).toBe(0);
    } finally {
      canal.cerrar();
      await d.cerrar();
    }
  });
});

/** Un repositorio real con una demora antes de guardar, para cruzar pedidos a propósito. */
const conDemora = (repo: RepositorioUbicaciones, demorar: (ping: Ping) => Promise<void>): RepositorioUbicaciones => ({
  guardar: async (ping) => {
    await demorar(ping);
    await repo.guardar(ping);
  },
  cercanos: (busqueda) => repo.cercanos(busqueda),
});

describe.each(['ingenua', 'optimizada'] as const)('orden y vigencia de lo publicado (%s)', (estrategia) => {
  let prefijo: string;
  let base: RepositorioUbicaciones;
  let conexion: Redis;
  let reloj: RelojFalso;
  const chofer = randomUUID();

  beforeEach(async () => {
    prefijo = nuevoPrefijo();
    reloj = new RelojFalso();
    if (estrategia === 'ingenua') {
      await prisma.$executeRawUnsafe('TRUNCATE pings');
      base = new RepositorioUbicacionesIngenuo(prisma);
    } else {
      base = repositorioGeoTest(redis).repo;
    }
    conexion = crearRedisPublicador(URL_REDIS_TEST, loggerSilencioso);
  });
  afterEach(() => {
    conexion.disconnect();
  });

  async function armar(repo: RepositorioUbicaciones, marcaMs = 2 * VIGENCIA_MS) {
    const publicador = new PublicadorPosicionesRedis(conexion, { prefijo, marcaMs });
    await publicador.listo();
    const resultados: ResultadoPublicacion[] = [];
    const casos = crearCasosDeUso({ repo, reloj, vigenciaMs: VIGENCIA_MS, publicador, alPublicar: (r) => resultados.push(r) });
    const canal = await escucharCanal(redis, canalPosicionChofer(prefijo, chofer));
    return { casos, resultados, canal };
  }

  it('un ping atrasado que termina de guardarse después de uno nuevo no se anuncia como actual', async () => {
    let abrir!: () => void;
    const puerta = new Promise<void>((r) => (abrir = r));
    const t1 = reloj.ahora();
    const { casos, resultados, canal } = await armar(
      conDemora(base, (p) => (p.registradoEn.getTime() === t1.getTime() ? puerta : Promise.resolve())),
    );
    try {
      // A (t1) queda demorado antes de guardar; B (t2) entra, se guarda y se publica.
      const a = casos.registrarUbicacion({ choferId: chofer, ...alNorte(100) });
      reloj.avanzar(1000);
      const t2 = reloj.ahora();
      await casos.registrarUbicacion({ choferId: chofer, ...alNorte(900) });
      abrir();
      await a;

      expect(await canal.hasta()).toEqual([mensajeDe(chofer, alNorte(900), t2)]);
      expect(resultados).toEqual(['publicada', 'atrasada']);
      // Lo publicado coincide con la posición vigente del repositorio.
      const [vigente] = await casos.buscarCandidatos({ origen: OBELISCO, radioMetros: 5000, limite: 10 });
      expect(vigente?.actualizadaEn).toEqual(t2);
    } finally {
      canal.cerrar();
    }
  });

  it('50 pings del mismo chofer que se cruzan: lo que llega al canal nunca retrocede', async () => {
    const { casos, resultados, canal } = await armar(conDemora(base, () => esperar(Math.floor(Math.random() * 30))));
    try {
      const pedidos: Promise<void>[] = [];
      for (let i = 0; i < 50; i++) {
        reloj.avanzar(10);
        pedidos.push(casos.registrarUbicacion({ choferId: chofer, ...alNorte(100 + i) }));
      }
      await Promise.all(pedidos);

      const tiempos = ((await canal.hasta()) as Array<{ actualizadaEn: string }>).map((m) => Date.parse(m.actualizadaEn));
      expect(tiempos.length).toBeGreaterThan(0);
      expect(tiempos).toEqual([...tiempos].sort((x, y) => x - y));
      expect(tiempos.at(-1)).toBe(reloj.ahora().getTime());
      expect(resultados.filter((r) => r === 'publicada')).toHaveLength(tiempos.length);
      expect(resultados).toHaveLength(50);
    } finally {
      canal.cerrar();
    }
  });

  it('sin marca de última publicación, un ping ya vencido no se publica', async () => {
    const { casos, resultados, canal } = await armar(
      conDemora(base, async () => {
        reloj.avanzar(VIGENCIA_MS + 1);
      }),
    );
    try {
      expect(await redis.exists(marcaPublicada(prefijo, chofer))).toBe(0);
      await casos.registrarUbicacion({ choferId: chofer, ...OBELISCO });
      expect(await canal.hasta()).toEqual([]);
      expect(resultados).toEqual(['vencida']);
      expect(await redis.exists(marcaPublicada(prefijo, chofer))).toBe(0);
    } finally {
      canal.cerrar();
    }
  });

  it('si la marca ya venció, un ping más viejo que el último publicado igual se descarta por vencido', async () => {
    let abrir!: () => void;
    const puerta = new Promise<void>((r) => (abrir = r));
    const t1 = reloj.ahora();
    // Marca muy corta para verla vencer en el test; en producción dura 2 × la vigencia.
    const { casos, resultados, canal } = await armar(
      conDemora(base, (p) => (p.registradoEn.getTime() === t1.getTime() ? puerta : Promise.resolve())),
      100,
    );
    try {
      const a = casos.registrarUbicacion({ choferId: chofer, ...alNorte(100) });
      reloj.avanzar(1000);
      const t2 = reloj.ahora();
      await casos.registrarUbicacion({ choferId: chofer, ...alNorte(900) });
      await expect.poll(() => redis.exists(marcaPublicada(prefijo, chofer)), { timeout: 2000 }).toBe(0);

      // A (t1, más viejo que t2) termina cuando ya no hay marca, y para entonces está vencido.
      reloj.avanzar(VIGENCIA_MS);
      abrir();
      await a;

      expect(await canal.hasta()).toEqual([mensajeDe(chofer, alNorte(900), t2)]);
      expect(resultados).toEqual(['publicada', 'vencida']);
    } finally {
      canal.cerrar();
    }
  });
});

describe('falla solo el publicador (optimizada): el ping se registra y responde 204', () => {
  let proxy: Awaited<ReturnType<typeof crearProxyRedis>>;
  let conexion: Redis;
  let publicador: PublicadorPosicionesRedis;
  let d: Location;
  let prefijo: string;

  beforeEach(async () => {
    prefijo = nuevoPrefijo();
    proxy = await crearProxyRedis();
    // El publicador pasa por el proxy; las posiciones y el historial usan el Redis de tests directo.
    conexion = crearRedisPublicador(proxy.url, loggerSilencioso);
    publicador = new PublicadorPosicionesRedis(conexion, { prefijo, marcaMs: 2 * VIGENCIA_MS });
    await publicador.listo();
    d = await levantarLocation({ publicador }, { UBICACION_ESTRATEGIA: 'optimizada', LOCATION_REDIS_PREFIJO: prefijo });
  });
  afterEach(async () => {
    conexion.disconnect();
    await proxy.cerrar();
    await d.cerrar();
  });

  async function informar(chofer: string, posicion = alNorte(250)) {
    const inicio = performance.now();
    const res = await request(d.url).post('/ubicaciones').set(await d.auth(chofer, 'chofer')).send(posicion);
    return { status: res.status, ms: performance.now() - inicio };
  }

  async function candidatosIds() {
    const res = await request(d.url)
      .get('/interno/candidatos')
      .query({ lat: OBELISCO.lat, lng: OBELISCO.lng })
      .set(d.servicio)
      .expect(200);
    return res.body.candidatos.map((c: { choferId: string }) => c.choferId);
  }

  it('Redis del publicador caído: falla enseguida, sin cola, y al volver no manda nada viejo', async () => {
    const chofer = randomUUID();
    const canal = await escucharCanal(redis, canalPosicionChofer(prefijo, chofer));
    try {
      proxy.estado.rechazar = true;
      proxy.cortar();
      await expect.poll(() => conexion.status, { timeout: 2000 }).not.toBe('ready');

      const { status, ms } = await informar(chofer);
      expect(status).toBe(204);
      // Sin cola offline no espera el timeout: falla en el momento.
      expect(ms).toBeLessThan(TIMEOUT_PUBLICACION_MS);
      expect(await candidatosIds()).toEqual([chofer]);
      expect(await metricaPublicacion(d, 'error')).toBe(1);

      // Vuelve la conexión: lo que falló no estaba encolado, así que no se publica tarde.
      proxy.estado.rechazar = false;
      await once(conexion, 'ready');
      expect(await canal.hasta()).toEqual([]);
      expect(await redis.exists(marcaPublicada(prefijo, chofer))).toBe(0);
    } finally {
      canal.cerrar();
    }
  });

  it('reconectando, con el handshake sin terminar: no encola ni espera, falla en el momento', async () => {
    const chofer = randomUUID();
    const canal = await escucharCanal(redis, canalPosicionChofer(prefijo, chofer));
    try {
      // Reconecta por el proxy, pero el handshake queda retenido: la conexión está abierta y sin estar
      // lista, sin cortes. Con cola offline, la publicación quedaría encolada para cuando termine.
      proxy.estado.retenerPedidos = true;
      proxy.cortar();
      await expect.poll(() => conexion.status, { timeout: 2000 }).toBe('connect');

      // Sin cola offline la publicación falla en el momento, no por timeout: con cola esperaría hasta
      // vencer (ioredis 6 descarta lo que vence en la cola, así que lo que cambia es la espera).
      const inicio = performance.now();
      await expect(
        publicador.publicar({ choferId: randomUUID(), posicion: OBELISCO, registradoEn: new Date() }),
      ).rejects.toThrow(/enableOfflineQueue/);
      expect(performance.now() - inicio).toBeLessThan(50);

      const { status, ms } = await informar(chofer);
      expect(status).toBe(204);
      expect(ms).toBeLessThan(TIMEOUT_PUBLICACION_MS);
      expect(await candidatosIds()).toEqual([chofer]);
      expect(await metricaPublicacion(d, 'error')).toBe(1);

      // El handshake termina sobre la misma conexión: no había nada encolado que mandar tarde.
      const lista = once(conexion, 'ready');
      proxy.soltar();
      await lista;
      expect(await canal.hasta()).toEqual([]);
      expect(await redis.exists(marcaPublicada(prefijo, chofer))).toBe(0);
    } finally {
      canal.cerrar();
    }
  });

  it('sin confirmación en 200 ms responde 204 igual: un timeout es falta de confirmación, no de publicación', async () => {
    const chofer = randomUUID();
    const canal = await escucharCanal(redis, canalPosicionChofer(prefijo, chofer));
    try {
      // Redis ejecuta el script, pero la respuesta no vuelve.
      proxy.estado.congelarRespuestas = true;
      const { status, ms } = await informar(chofer);
      expect(status).toBe(204);
      expect(ms).toBeGreaterThanOrEqual(TIMEOUT_PUBLICACION_MS - 10);
      expect(ms).toBeLessThan(1000);
      expect(await candidatosIds()).toEqual([chofer]);
      expect(await metricaPublicacion(d, 'error')).toBe(1);
      // Se contó como error, pero la publicación ocurrió.
      expect(await canal.hasta()).toHaveLength(1);
    } finally {
      canal.cerrar();
    }
  });

  it('lo que quedó sin respuesta antes de un corte no se reenvía al reconectar', async () => {
    const chofer = randomUUID();
    const canal = await escucharCanal(redis, canalPosicionChofer(prefijo, chofer));
    try {
      // El pedido no llega a Redis: queda sin respuesta y vence a los 200 ms.
      proxy.estado.congelarPedidos = true;
      const { status } = await informar(chofer);
      expect(status).toBe(204);
      expect(await metricaPublicacion(d, 'error')).toBe(1);

      proxy.estado.congelarPedidos = false;
      const reconectada = once(conexion, 'ready');
      proxy.cortar();
      await reconectada;

      expect(await canal.hasta()).toEqual([]);
      expect(await redis.exists(marcaPublicada(prefijo, chofer))).toBe(0);
      // Y el publicador sigue funcionando después del corte.
      expect((await informar(chofer)).status).toBe(204);
      expect(await canal.hasta()).toHaveLength(1);
    } finally {
      canal.cerrar();
    }
  });
});
