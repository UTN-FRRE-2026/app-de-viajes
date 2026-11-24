import { crearLogger } from '@viajes/platform';
import { describe, expect, it } from 'vitest';
import { crearCasosDeFlotas } from '../../src/dominio/casos-uso/flotas.js';
import type { Coordenada } from '../../src/dominio/entidades/index.js';
import type { ElegibilidadChoferes } from '../../src/dominio/puertos/index.js';
import { RepositorioFlotasMemoria } from '../../src/infra/memoria/flotas-memoria.js';
import { RepositorioDespachoMemoria } from '../../src/infra/memoria/repositorio-memoria.js';
import type { ResultadoCache } from '../../src/infra/tarifas/proveedor-tarifas.js';
import { cacheZonasMemoria, type CacheZonas } from '../../src/infra/zonas/cache-zonas.js';
import { ElegibilidadConCache, type ElegibilidadConMapa } from '../../src/infra/zonas/elegibilidad-con-cache.js';
import { ubicarEnZona, zonaEnMapa, type MapaZonas } from '../../src/infra/zonas/mapa-zonas.js';
import { DirectorioFalso } from '../soporte/directorio-falso.js';

type Punto = [number, number];
const rect = (lng1: number, lat1: number, lng2: number, lat2: number): Punto[] => [
  [lng1, lat1],
  [lng2, lat1],
  [lng2, lat2],
  [lng1, lat2],
  [lng1, lat1],
];

// Norte y Sur se tocan en lat -34.6; Norte tiene el id menor.
const NORTE = '00000000-0000-4000-8000-00000000000a';
const SUR = '00000000-0000-4000-8000-00000000000b';
const VACIA = '00000000-0000-4000-8000-00000000000c';
const FLOTA_A = '00000000-0000-4000-8000-0000000000f1';
const FLOTA_B = '00000000-0000-4000-8000-0000000000f2';
const mapaBase = (): MapaZonas => ({
  zonas: [
    { id: NORTE, anillos: [rect(-58.5, -34.6, -58.4, -34.5)], flotas: [FLOTA_A] },
    { id: SUR, anillos: [rect(-58.5, -34.7, -58.4, -34.6)], flotas: [FLOTA_B] },
    { id: VACIA, anillos: [rect(-58.3, -34.7, -58.2, -34.6)], flotas: [] },
  ],
});
const EN_NORTE: Coordenada = { lat: -34.55, lng: -58.45 };
const EN_SUR: Coordenada = { lat: -34.65, lng: -58.45 };
const EN_EL_BORDE: Coordenada = { lat: -34.6, lng: -58.45 };
const AFUERA: Coordenada = { lat: -34.4, lng: -58.45 };

describe('el mapa de zonas: la geometría en JavaScript', () => {
  it('adentro, afuera y, cerca de un lado, «cerca» (lo decide PostGIS)', () => {
    const anillo = rect(0, 0, 1, 1);
    expect(ubicarEnZona([0.5, 0.5], [anillo])).toBe('adentro');
    expect(ubicarEnZona([1.5, 0.5], [anillo])).toBe('afuera');
    expect(ubicarEnZona([1, 0.5], [anillo])).toBe('cerca');
    expect(ubicarEnZona([0.5, 1 + 5e-8], [anillo])).toBe('cerca');
    expect(ubicarEnZona([0.5, 1 + 1e-6], [anillo])).toBe('afuera');
    // Un vértice a la altura del punto no cuenta dos veces.
    expect(ubicarEnZona([0.5, 0.5], [[[0, 0.5], [1, 0], [2, 0.5], [1, 1], [0, 0.5]]])).toBe('adentro');
  });

  it('un hueco resta: el punto en el hueco está afuera', () => {
    expect(ubicarEnZona([0.5, 0.5], [rect(0, 0, 1, 1), rect(0.25, 0.25, 0.75, 0.75)])).toBe('afuera');
    expect(ubicarEnZona([0.1, 0.1], [rect(0, 0, 1, 1), rect(0.25, 0.25, 0.75, 0.75)])).toBe('adentro');
  });

  it('la zona del punto, null fuera de toda zona, y «dudoso» en el borde compartido', () => {
    expect(zonaEnMapa(mapaBase(), EN_NORTE)).toEqual({ zonaId: NORTE });
    expect(zonaEnMapa(mapaBase(), EN_SUR)).toEqual({ zonaId: SUR });
    expect(zonaEnMapa(mapaBase(), AFUERA)).toEqual({ zonaId: null });
    expect(zonaEnMapa(mapaBase(), EN_EL_BORDE)).toBe('dudoso');
  });
});

/** Postgres de mentira: anota lo que se le pregunta. */
class BaseFalsa implements ElegibilidadConMapa {
  mapa = mapaBase();
  readonly llamadas: string[] = [];
  async mapaDeZonas() {
    this.llamadas.push('mapa');
    return structuredClone(this.mapa);
  }
  async zonaDelOrigen() {
    this.llamadas.push('zonaDelOrigen');
    return NORTE;
  }
  async aptos(ids: readonly string[], zonaId: string) {
    this.llamadas.push(`aptos ${zonaId}`);
    return [...ids];
  }
  async aptosDeFlotas(ids: readonly string[], flotas: readonly string[]) {
    this.llamadas.push(`aptosDeFlotas ${flotas.join(',')}`);
    return [...ids];
  }
}

function sistema(cache: CacheZonas = cacheZonasMemoria()) {
  const base = new BaseFalsa();
  const lecturas: ResultadoCache[] = [];
  const elegibilidad = new ElegibilidadConCache({
    base,
    cache,
    logger: crearLogger('zonas-test', 'silent'),
    alLeerCache: (r) => lecturas.push(r),
  });
  return { base, lecturas, elegibilidad };
}

const fallar = () => Promise.reject(new Error('redis caído'));

describe('ElegibilidadConCache', () => {
  it('MISS (lee Postgres una vez y lo guarda) y después HIT, sin PostGIS para un punto lejos de los bordes', async () => {
    const { base, lecturas, elegibilidad } = sistema();
    expect(await elegibilidad.zonaDelOrigen(EN_NORTE)).toBe(NORTE);
    expect(await elegibilidad.zonaDelOrigen(EN_SUR)).toBe(SUR);
    expect(await elegibilidad.zonaDelOrigen(AFUERA)).toBeNull();
    expect(lecturas).toEqual(['miss', 'hit', 'hit']);
    expect(base.llamadas).toEqual(['mapa']);
  });

  it('en el borde compartido pregunta a PostGIS', async () => {
    const { base, elegibilidad } = sistema();
    expect(await elegibilidad.zonaDelOrigen(EN_EL_BORDE)).toBe(NORTE);
    expect(base.llamadas).toEqual(['mapa', 'zonaDelOrigen']);
  });

  it('el filtro usa las flotas de la zona del mapa; una zona sin flotas no consulta la base; una que el mapa no tiene, la consulta de siempre', async () => {
    const { base, elegibilidad } = sistema();
    expect(await elegibilidad.aptos(['c1', 'c2'], NORTE)).toEqual(['c1', 'c2']);
    expect(await elegibilidad.aptos(['c1'], VACIA)).toEqual([]);
    expect(await elegibilidad.aptos(['c1'], 'otra')).toEqual(['c1']);
    expect(await elegibilidad.aptos([], NORTE)).toEqual([]);
    expect(base.llamadas).toEqual(['mapa', `aptosDeFlotas ${FLOTA_A}`, 'aptos otra']);
  });

  it('invalidar: la próxima lectura es un MISS y ve el cambio', async () => {
    const { base, lecturas, elegibilidad } = sistema();
    expect(await elegibilidad.zonaDelOrigen(AFUERA)).toBeNull();
    base.mapa.zonas.push({ id: 'nueva', anillos: [rect(-58.5, -34.5, -58.4, -34.3)], flotas: [FLOTA_A] });
    // Sin invalidar, el caché todavía no la tiene.
    expect(await elegibilidad.zonaDelOrigen(AFUERA)).toBeNull();
    await elegibilidad.zonasCambiadas();
    expect(await elegibilidad.zonaDelOrigen(AFUERA)).toBe('nueva');
    expect(lecturas).toEqual(['miss', 'hit', 'miss']);
  });

  it('un mapa guardado con una generación vieja no se lee (un MISS lento que guarda tarde)', async () => {
    const cache = cacheZonasMemoria();
    const { generacion } = await cache.leer();
    await cache.invalidar();
    await cache.guardar(generacion, { zonas: [] });
    expect((await cache.leer()).mapa).toBeNull();
  });

  it('si Redis falla al leer: ERROR, y todo sale de Postgres con las consultas de siempre', async () => {
    const { base, lecturas, elegibilidad } = sistema({ leer: fallar, guardar: fallar, invalidar: fallar });
    expect(await elegibilidad.zonaDelOrigen(EN_SUR)).toBe(NORTE); // lo que diga Postgres
    expect(await elegibilidad.aptos(['c1'], SUR)).toEqual(['c1']);
    await expect(elegibilidad.zonasCambiadas()).resolves.toBeUndefined();
    expect(lecturas).toEqual(['error', 'error']);
    expect(base.llamadas).toEqual(['zonaDelOrigen', `aptos ${SUR}`]);
  });

  it('si Redis falla al guardar, igual responde con lo que leyó de Postgres', async () => {
    const memoria = cacheZonasMemoria();
    const { lecturas, elegibilidad } = sistema({ ...memoria, guardar: fallar });
    expect(await elegibilidad.zonaDelOrigen(EN_SUR)).toBe(SUR);
    expect(await elegibilidad.zonaDelOrigen(EN_SUR)).toBe(SUR);
    expect(lecturas).toEqual(['miss', 'miss']);
  });
});

describe('los casos de flotas avisan al caché después del COMMIT', () => {
  function casos() {
    const avisos: string[] = [];
    const elegibilidad: Pick<ElegibilidadChoferes, 'zonasCambiadas'> = { zonasCambiadas: async () => void avisos.push('cambio') };
    const repoFlotas = new RepositorioFlotasMemoria();
    const c = crearCasosDeFlotas({ repoFlotas, directorio: new DirectorioFalso(), viajes: new RepositorioDespachoMemoria(), elegibilidad });
    return { c, avisos };
  }

  it('al guardar una zona y al cambiar las de una flota; no si el cambio falla', async () => {
    const { c, avisos } = casos();
    await c.guardarZona({ id: NORTE, nombre: 'Norte', anillo: rect(-58.5, -34.6, -58.4, -34.5) });
    expect(avisos).toHaveLength(1);
    await expect(c.guardarZona({ id: SUR, nombre: 'Encima', anillo: rect(-58.45, -34.58, -58.35, -34.52) })).rejects.toMatchObject({
      codigo: 'ZONAS_SUPERPUESTAS',
    });
    expect(avisos).toHaveLength(1);
    await c.guardarFlota({ id: FLOTA_A, nombre: 'A', maxActivos: 5 });
    await c.zonasDeFlota(FLOTA_A, [NORTE]);
    expect(avisos).toHaveLength(2);
    await expect(c.zonasDeFlota(FLOTA_A, [SUR])).rejects.toMatchObject({ codigo: 'ZONA_NO_ENCONTRADA' });
    expect(avisos).toHaveLength(2);
  });
});
