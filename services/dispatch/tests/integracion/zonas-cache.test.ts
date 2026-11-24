import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cacheZonasRedis, type CacheZonas } from '../../src/infra/zonas/cache-zonas.js';
import { preparadorFlotas } from '../soporte/flotas.js';
import { CON_METRICAS, clave, DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';

/**
 * El caché de zonas en Redis, contra PostGIS y Redis reales: MISS y HIT, la invalidación al editar
 * zonas o las de una flota, Redis caído, y que la aceptación no use el caché.
 */
type Dispatch = Awaited<ReturnType<typeof levantarDispatch>>;

let d: Dispatch;
let real: CacheZonas;
let preparar: ReturnType<typeof preparadorFlotas>;
/** Para simular, sobre el caché real, que Redis no responde o que la invalidación falla. */
const control = { caido: false, sinInvalidar: false };
const fallar = () => Promise.reject(new Error('ECONNREFUSED'));

beforeAll(async () => {
  d = await levantarDispatch({
    zonas: {
      cache: (r) => {
        real = r;
        return {
          leer: () => (control.caido ? fallar() : r.leer()),
          guardar: (g, m) => (control.caido ? fallar() : r.guardar(g, m)),
          invalidar: () => (control.caido || control.sinInvalidar ? fallar() : r.invalidar()),
        };
      },
    },
  });
  preparar = preparadorFlotas(d.casosFlotas, d.directorio);
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  control.caido = false;
  control.sinInvalidar = false;
  await d.limpiar();
  await d.sinZonaDeTest();
  // El TRUNCATE de arriba es SQL directo: no pasa por los casos de uso, así que no invalida.
  await real.invalidar();
});

const ADMIN = randomUUID();
const comoAdmin = () => d.auth(ADMIN, 'admin');

const NORTE = '00000000-0000-4000-8000-00000000000a';
const NUEVA = '00000000-0000-4000-8000-00000000000d';
const rectangulo = (lng1: number, lat1: number, lng2: number, lat2: number) => ({
  type: 'Polygon' as const,
  coordinates: [
    [
      [lng1, lat1],
      [lng2, lat1],
      [lng2, lat2],
      [lng1, lat2],
      [lng1, lat1],
    ],
  ],
});
const AREA_NORTE = rectangulo(-58.5, -34.6, -58.4, -34.5);
const EN_NORTE = { lat: -34.55, lng: -58.45 };
const AFUERA = { lat: -34.4, lng: -58.45 };

const guardarZona = async (id: string, area: unknown) =>
  request(d.url).put(`/admin/zonas/${id}`).set(clave()).set(await comoAdmin()).send({ nombre: `Zona ${id.slice(-1)}`, area });
const zonasDeFlota = async (flotaId: string, zonas: string[]) =>
  request(d.url).put(`/admin/flotas/${flotaId}/zonas`).set(clave()).set(await comoAdmin()).send({ zonas });
const pedir = async (origen: { lat: number; lng: number }, s: Dispatch = d) =>
  request(s.url).post('/solicitudes').set(clave()).set(await s.auth(randomUUID(), 'pasajero')).send({ origen, destino: DESTINO });
const ofrecidos = async (solicitudId: string) => (await d.prisma.oferta.findMany({ where: { solicitudId } })).map((o) => o.choferId);
const aceptar = async (solicitudId: string, chofer: string) => {
  const oferta = await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId, choferId: chofer } });
  return request(d.url).post(`/ofertas/${oferta.id}/aceptar`).set(clave()).set(await d.auth(chofer, 'chofer')).send({});
};

async function lecturas(resultado: 'hit' | 'miss' | 'error'): Promise<number> {
  const texto = (await request(d.url).get('/metrics').set(CON_METRICAS)).text;
  const m = texto.match(new RegExp(`^dispatch_zonas_cache_total\\{resultado="${resultado}",servicio="dispatch"\\} (\\d+)`, 'm'));
  return Number(m?.[1]);
}

/** Una flota que opera en Norte, con un chofer apto que location devuelve. */
async function flotaEnNorte() {
  expect((await guardarZona(NORTE, AREA_NORTE)).status).toBe(200);
  const flota = (await preparar.flota(10)).id;
  expect((await zonasDeFlota(flota, [NORTE])).status).toBe(200);
  const chofer = await preparar.chofer(flota);
  await d.casosFlotas.activarChofer({ fleetId: flota }, chofer);
  await d.casosFlotas.cambiarDisponibilidad(chofer, true);
  d.buscador.choferes = [chofer];
  return { flota, chofer };
}

describe('caché de zonas en Redis', () => {
  it('MISS y después HIT: el mapa queda en Redis y el segundo pedido no lo vuelve a leer de Postgres', async () => {
    const { chofer } = await flotaEnNorte();
    const [hits, misses] = [await lecturas('hit'), await lecturas('miss')];

    const primero = await pedir(EN_NORTE);
    expect(primero.status).toBe(201);
    expect(await ofrecidos(primero.body.id)).toEqual([chofer]);
    expect(await lecturas('miss')).toBe(misses + 1);

    const generacion = await d.redis.get(`${d.prefijoCacheZonas}generacion`);
    const guardado = JSON.parse((await d.redis.get(`${d.prefijoCacheZonas}mapa:${generacion}`))!);
    expect(guardado.zonas).toEqual([expect.objectContaining({ id: NORTE, flotas: [expect.any(String)] })]);
    expect(await d.redis.ttl(`${d.prefijoCacheZonas}mapa:${generacion}`)).toBeGreaterThan(0);

    const segundo = await pedir(EN_NORTE);
    expect(await ofrecidos(segundo.body.id)).toEqual([chofer]);
    expect(await lecturas('miss')).toBe(misses + 1);
    expect(await lecturas('hit')).toBeGreaterThan(hits);
  });

  it('una entrada rota en Redis cuenta como MISS y se reemplaza', async () => {
    await flotaEnNorte();
    expect((await pedir(EN_NORTE)).status).toBe(201);
    const generacion = await d.redis.get(`${d.prefijoCacheZonas}generacion`);
    await d.redis.set(`${d.prefijoCacheZonas}mapa:${generacion}`, '{"zonas":[{"id":1}]}');
    const misses = await lecturas('miss');
    expect((await pedir(EN_NORTE)).status).toBe(201);
    expect(await lecturas('miss')).toBe(misses + 1);
    expect(JSON.parse((await d.redis.get(`${d.prefijoCacheZonas}mapa:${generacion}`))!).zonas[0].id).toBe(NORTE);
  });

  it('crear o mover una zona: el pedido siguiente ya la ve', async () => {
    const { flota } = await flotaEnNorte();
    expect((await pedir(AFUERA)).body.error.code).toBe('ORIGEN_FUERA_DE_ZONA'); // caché cargado

    // Una zona nueva que cubre AFUERA (toca a Norte en el borde), con la flota.
    expect((await guardarZona(NUEVA, rectangulo(-58.5, -34.5, -58.4, -34.3))).status).toBe(200);
    expect((await zonasDeFlota(flota, [NORTE, NUEVA])).status).toBe(200);
    const res = await pedir(AFUERA);
    expect(res.status).toBe(201);
    expect((await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: res.body.id } })).zonaId).toBe(NUEVA);

    // Norte se muda al este: su origen de antes queda afuera.
    expect((await guardarZona(NORTE, rectangulo(-58.4, -34.6, -58.3, -34.5))).status).toBe(200);
    expect((await pedir(EN_NORTE)).body.error.code).toBe('ORIGEN_FUERA_DE_ZONA');
  });

  it('quitar o devolver la zona a una flota: el pedido siguiente ya lo ve', async () => {
    const { flota, chofer } = await flotaEnNorte();
    expect(await ofrecidos((await pedir(EN_NORTE)).body.id)).toEqual([chofer]);

    expect((await zonasDeFlota(flota, [])).status).toBe(200);
    expect((await pedir(EN_NORTE)).body.estado).toBe('SIN_CHOFERES');

    expect((await zonasDeFlota(flota, [NORTE])).status).toBe(200);
    expect(await ofrecidos((await pedir(EN_NORTE)).body.id)).toEqual([chofer]);
  });

  it('sin la invalidación, el caché queda viejo (hasta el TTL): por eso los cambios invalidan', async () => {
    const { flota, chofer } = await flotaEnNorte();
    expect(await ofrecidos((await pedir(EN_NORTE)).body.id)).toEqual([chofer]);
    control.sinInvalidar = true;
    // El cambio se guarda igual (200): la invalidación que falla no rompe el pedido del admin.
    expect((await zonasDeFlota(flota, [])).status).toBe(200);
    expect(await ofrecidos((await pedir(EN_NORTE)).body.id)).toEqual([chofer]);
  });
});

describe('la aceptación no usa el caché', () => {
  it('con el caché viejo, al chofer le siguen llegando ofertas de la zona que su flota perdió, pero aceptar da 409 CHOFER_NO_APTO', async () => {
    const { flota, chofer } = await flotaEnNorte();
    const antes = await pedir(EN_NORTE);
    expect(await ofrecidos(antes.body.id)).toEqual([chofer]);

    // Se le quita la zona a la flota entre la oferta y la aceptación, y la invalidación falla.
    control.sinInvalidar = true;
    expect((await zonasDeFlota(flota, [])).status).toBe(200);
    const despues = await pedir(EN_NORTE);
    expect(await ofrecidos(despues.body.id)).toEqual([chofer]); // el caché todavía cree que opera ahí

    for (const solicitud of [antes.body.id, despues.body.id]) {
      const res = await aceptar(solicitud, chofer);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CHOFER_NO_APTO');
    }
    expect(await d.prisma.solicitudViaje.count({ where: { estado: 'ASIGNADO' } })).toBe(0);
  });
});

describe('Redis caído: todo sale de Postgres', () => {
  it('los pedidos funcionan, se cuentan como error, y los cambios se ven igual', async () => {
    const { flota, chofer } = await flotaEnNorte();
    control.caido = true;
    const errores = await lecturas('error');

    expect(await ofrecidos((await pedir(EN_NORTE)).body.id)).toEqual([chofer]);
    expect((await pedir(AFUERA)).body.error.code).toBe('ORIGEN_FUERA_DE_ZONA');
    expect(await lecturas('error')).toBeGreaterThan(errores);

    expect((await zonasDeFlota(flota, [])).status).toBe(200);
    expect((await pedir(EN_NORTE)).body.estado).toBe('SIN_CHOFERES');
  });

  it('con un Redis de verdad que no responde, el pedido no se cuelga: corta en el tiempo límite y usa Postgres', async () => {
    const muerto = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false });
    muerto.on('error', () => {}); // el ECONNREFUSED es lo esperado
    // Este dispatch vuelve a poner la zona de test (todo el mapa), con sus choferes aptos.
    const sinRedis = await levantarDispatch({
      zonas: { cache: () => cacheZonasRedis(muerto, { prefijo: 'x:', ttlSegundos: 60, timeoutMs: 200 }) },
    });
    try {
      sinRedis.buscador.choferes = [randomUUID()];
      const inicio = Date.now();
      const res = await pedir(ORIGEN, sinRedis);
      expect(res.status).toBe(201);
      expect(res.body.estado).toBe('BUSCANDO');
      expect(Date.now() - inicio).toBeLessThan(3000);
    } finally {
      await sinRedis.cerrar();
      muerto.disconnect();
    }
  });
});
