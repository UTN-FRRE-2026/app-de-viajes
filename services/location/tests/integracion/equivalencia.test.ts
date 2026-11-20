import type { Reloj } from '@viajes/kernel';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearCasosDeUso, type CandidatoCercano } from '../../src/dominio/casos-uso/index.js';
import { distanciaMetros, type Coordenada } from '../../src/dominio/entidades/index.js';
import type { RepositorioUbicaciones } from '../../src/dominio/puertos/index.js';
import { crearPrisma } from '../../src/infra/db/cliente.js';
import { RepositorioUbicacionesIngenuo } from '../../src/infra/db/repositorio-ingenuo.js';
import { RepositorioUbicacionesMemoria } from '../../src/infra/memoria/repositorio-memoria.js';
import { radioConMargen } from '../../src/infra/redis/repositorio-geo.js';
import { OBELISCO, VIGENCIA_MS } from '../soporte/memoria.js';
import { URL_BD_TEST } from '../soporte/preparar-bd.js';
import { borrarPrefijo, crearRedisTest, repositorioGeoTest } from '../soporte/redis.js';

// Las tres estrategias tienen que devolver EXACTAMENTE lo mismo: ids, orden, distancias y fechas.

const prisma = crearPrisma(URL_BD_TEST, 5);
let redis: Redis;
const prefijos: string[] = [];

class RelojManual implements Reloj {
  t = Date.parse('2026-11-20T12:00:00Z');
  ahora() {
    return new Date(this.t);
  }
}

interface Ping extends Coordenada {
  choferId: string;
  t: number;
}

/** Arma las tres estrategias con el mismo reloj, les aplica los mismos pings y devuelve un buscador. */
async function tresEstrategias(pings: Ping[]) {
  await prisma.$executeRawUnsafe('TRUNCATE pings');
  const geo = repositorioGeoTest(redis);
  prefijos.push(geo.claves.posiciones.replace(/pos$/, ''));
  const repos: Record<string, RepositorioUbicaciones> = {
    memoria: new RepositorioUbicacionesMemoria(),
    ingenua: new RepositorioUbicacionesIngenuo(prisma),
    optimizada: geo.repo,
  };
  const reloj = new RelojManual();
  const casos = Object.fromEntries(
    Object.entries(repos).map(([n, repo]) => [n, crearCasosDeUso({ repo, reloj, vigenciaMs: VIGENCIA_MS })]),
  );
  for (const p of pings) {
    reloj.t = p.t;
    for (const c of Object.values(casos)) await c.registrarUbicacion(p);
  }
  return {
    reloj,
    async buscar(origen: Coordenada, radioMetros: number, limite: number) {
      const r: Record<string, CandidatoCercano[]> = {};
      for (const [n, c] of Object.entries(casos)) r[n] = await c.buscarCandidatos({ origen, radioMetros, limite });
      return r;
    },
  };
}

const ids = (cs: CandidatoCercano[] | undefined) => (cs ?? []).map((c) => c.choferId);

/** Generador con semilla (mulberry32): el mismo conjunto de datos en cada corrida. */
function aleatorio(semilla: number) {
  let a = semilla;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** Un punto exactamente a `metros` al norte del origen según el haversine del dominio (R = 6 371 008,8 m). */
const metrosPorGrado = (6_371_008.8 * Math.PI) / 180;
const alNorteExacto = (o: Coordenada, metros: number) => ({ lat: o.lat + metros / metrosPorGrado, lng: o.lng });
const alSurExacto = (o: Coordenada, metros: number) => ({ lat: o.lat - metros / metrosPorGrado, lng: o.lng });

beforeAll(() => {
  redis = crearRedisTest();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE pings');
});
afterAll(async () => {
  for (const p of prefijos) await borrarPrefijo(redis, p);
  redis.disconnect();
  await prisma.$disconnect();
});

describe('equivalencia entre memoria, ingenua y optimizada', () => {
  it('300 choferes y 200 búsquedas al azar (con semilla): resultados idénticos', async () => {
    const azar = aleatorio(20261120);
    const t0 = Date.parse('2026-11-20T12:00:00Z');
    const pings: Ping[] = [];
    for (let i = 1; i <= 300; i++) {
      const vueltas = 1 + Math.floor(azar() * 4);
      // Algunos choferes dejan de reportar antes de la ventana de vigencia: deben quedar afuera.
      let t = t0 - Math.floor(azar() * 70_000);
      for (let v = 0; v < vueltas; v++) {
        pings.push({ choferId: uuid(i), lat: OBELISCO.lat + (azar() - 0.5) * 0.3, lng: OBELISCO.lng + (azar() - 0.5) * 0.3, t });
        t += 2000;
      }
    }
    pings.sort((a, b) => a.t - b.t);
    const e = await tresEstrategias(pings);
    e.reloj.t = t0 + 10_000;

    const radios = [100, 500, 1000, 3000, 5000, 10_000, 20_000, 50_000];
    const limites = [1, 3, 10, 50, 100];
    let conResultados = 0;
    for (let q = 0; q < 200; q++) {
      const origen = { lat: OBELISCO.lat + (azar() - 0.5) * 0.3, lng: OBELISCO.lng + (azar() - 0.5) * 0.3 };
      const radio = radios[Math.floor(azar() * radios.length)] as number;
      const limite = limites[Math.floor(azar() * limites.length)] as number;
      const r = await e.buscar(origen, radio, limite);
      expect(r['ingenua'], `búsqueda ${q}`).toEqual(r['memoria']);
      expect(r['optimizada'], `búsqueda ${q}`).toEqual(r['memoria']);
      if ((r['memoria'] ?? []).length > 0) conResultados++;
    }
    // Que la prueba no pase por estar todo vacío.
    expect(conResultados).toBeGreaterThan(100);
  });

  it('borde del radio: entra lo que está a r − 0,3 m y r − 0,5 m; queda afuera r + 0,3 m y r + 0,9 m', async () => {
    const r = 5000;
    const puntos = [
      { choferId: uuid(1), ...alNorteExacto(OBELISCO, r - 0.5) },
      { choferId: uuid(2), ...alNorteExacto(OBELISCO, r - 0.3) },
      { choferId: uuid(3), ...alNorteExacto(OBELISCO, r + 0.3) },
      // Dentro del margen que se le pide a Redis, pero fuera del radio: lo descarta el dominio.
      { choferId: uuid(4), ...alNorteExacto(OBELISCO, r + 0.9) },
    ];
    expect(distanciaMetros(OBELISCO, puntos[3] as Coordenada)).toBeLessThan(radioConMargen(r));
    const t = Date.parse('2026-11-20T12:00:00Z');
    const e = await tresEstrategias(puntos.map((p) => ({ ...p, t })));
    const res = await e.buscar(OBELISCO, r, 100);
    for (const n of ['memoria', 'ingenua', 'optimizada']) expect(ids(res[n]), n).toEqual([uuid(1), uuid(2)]);
  });

  it('orden: empates exactos por id y distancias que difieren en centímetros', async () => {
    const t = Date.parse('2026-11-20T12:00:00Z');
    const mismo = alNorteExacto(OBELISCO, 2000);
    const pings = [
      { choferId: uuid(30), ...mismo, t },
      { choferId: uuid(10), ...mismo, t },
      { choferId: uuid(20), ...alSurExacto(OBELISCO, 2000.03), t }, // 3 cm más lejos, en otra dirección
      { choferId: uuid(40), ...alSurExacto(OBELISCO, 1999.98), t }, // 2 cm más cerca
    ];
    const e = await tresEstrategias(pings);
    const res = await e.buscar(OBELISCO, 5000, 10);
    for (const n of ['memoria', 'ingenua', 'optimizada']) {
      expect(ids(res[n]), n).toEqual([uuid(40), uuid(10), uuid(30), uuid(20)]);
    }
  });

  it('latitudes fuera del rango de Redis: choferes y orígenes polares', async () => {
    const t = Date.parse('2026-11-20T12:00:00Z');
    const pings = [
      { choferId: uuid(1), lat: 85.2, lng: 10, t }, // fuera del rango GEO
      { choferId: uuid(2), lat: 85.0, lng: 10, t }, // dentro del rango GEO
      { choferId: uuid(3), lat: 89.95, lng: 0, t },
      { choferId: uuid(4), lat: 89.6, lng: 120, t }, // ~40 km del origen polar, cruzando meridianos
      { choferId: uuid(5), lat: -89.9, lng: 0, t },
    ];
    const e = await tresEstrategias(pings);
    // Origen dentro del rango: tiene que encontrar también al chofer de 85,2.
    const cerca85 = await e.buscar({ lat: 84.95, lng: 10 }, 50_000, 10);
    // Origen fuera del rango de Redis.
    const enElPolo = await e.buscar({ lat: 89.9, lng: 60 }, 50_000, 10);
    for (const [nombre, r] of [['cerca de 85°', cerca85], ['en el polo', enElPolo]] as const) {
      expect(r['optimizada'], nombre).toEqual(r['memoria']);
      expect(r['ingenua'], nombre).toEqual(r['memoria']);
    }
    expect(ids(cerca85['memoria'])).toEqual([uuid(2), uuid(1)]);
    expect(ids(enElPolo['memoria']).sort()).toEqual([uuid(3), uuid(4)].sort());
  });

  it('cerca del antimeridiano encuentra choferes del otro lado de ±180°', async () => {
    const t = Date.parse('2026-11-20T12:00:00Z');
    const e = await tresEstrategias([
      { choferId: uuid(1), lat: -16.5, lng: -179.995, t },
      { choferId: uuid(2), lat: -16.5, lng: 179.99, t },
    ]);
    const r = await e.buscar({ lat: -16.5, lng: 179.995 }, 3000, 10);
    expect(ids(r['memoria'])).toEqual([uuid(2), uuid(1)]);
    expect(r['optimizada']).toEqual(r['memoria']);
    expect(r['ingenua']).toEqual(r['memoria']);
  });
});
