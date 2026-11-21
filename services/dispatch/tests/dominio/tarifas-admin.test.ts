import { randomUUID } from 'node:crypto';
import { crearLogger } from '@viajes/platform';
import { describe, expect, it } from 'vitest';
import { crearCasosDeUso } from '../../src/dominio/casos-uso/index.js';
import type { ParametrosTarifa } from '../../src/dominio/tarifas/parametros.js';
import { BuscadorCandidatosFijo } from '../../src/infra/externos/buscador-fijo.js';
import { RepositorioDespachoMemoria } from '../../src/infra/memoria/repositorio-memoria.js';
import { RepositorioTarifasMemoria } from '../../src/infra/memoria/tarifas-memoria.js';
import { ProveedorTarifasVersionadas, type CacheTarifas, type ResultadoCache } from '../../src/infra/tarifas/proveedor-tarifas.js';
import { MapasFalso } from '../soporte/mapas-falso.js';
import { DESTINO, ORIGEN, RelojFalso, VALORES_PRUEBA } from '../soporte/memoria.js';

const ADMIN = randomUUID();
const OTROS = { bajadaCentavos: 300_000, centavosPorKm: 60_000, centavosPorMinuto: 0, minimoCentavos: 400_000, maxMetros: 80_000 };

/** Caché en memoria que anota lo que pasa y puede fallar a pedido. */
class CacheFalso implements CacheTarifas {
  readonly entradas = new Map<string, ParametrosTarifa>();
  readonly operaciones: string[] = [];
  falla: { leer?: boolean; guardar?: boolean; borrar?: boolean } = {};
  async leer(version: string) {
    this.operaciones.push(`leer ${version}`);
    if (this.falla.leer) throw new Error('redis caído');
    return this.entradas.get(version) ?? null;
  }
  async guardar(p: ParametrosTarifa) {
    this.operaciones.push(`guardar ${p.version}`);
    if (this.falla.guardar) throw new Error('redis caído');
    this.entradas.set(p.version, { ...p });
  }
  async borrar(version: string) {
    this.operaciones.push(`borrar ${version}`);
    if (this.falla.borrar) throw new Error('redis caído');
    this.entradas.delete(version);
  }
}

function sistema() {
  const repoTarifas = new RepositorioTarifasMemoria();
  const cache = new CacheFalso();
  const lecturas: ResultadoCache[] = [];
  const tarifas = new ProveedorTarifasVersionadas({
    repo: repoTarifas,
    semilla: VALORES_PRUEBA,
    cache,
    logger: crearLogger('tarifas-test', 'silent'),
    alLeerCache: (r) => lecturas.push(r),
  });
  const mapas = new MapasFalso();
  mapas.modo = { recorrido: { metros: 5000, segundos: 600 } };
  const casos = crearCasosDeUso({
    repo: new RepositorioDespachoMemoria(),
    buscador: new BuscadorCandidatosFijo([]),
    reloj: new RelojFalso(),
    ids: { nuevo: () => randomUUID() },
    parametros: { ofertasSimultaneas: 3, ttlOfertaMs: 15_000 },
    mapas,
    tarifas,
    repoTarifas,
    semillaTarifa: VALORES_PRUEBA,
  });
  const estimar = () => casos.estimarTarifa({ origen: ORIGEN, destino: DESTINO });
  return { casos, repoTarifas, cache, lecturas, tarifas, estimar };
}

describe('semilla', () => {
  it('la primera lectura crea la versión 1 con los valores del entorno; las siguientes no crean otra', async () => {
    const { casos, repoTarifas } = sistema();
    const t = await casos.obtenerTarifa();
    expect(t).toMatchObject({ version: 'v1', moneda: 'ARS', ...VALORES_PRUEBA, actualizadaPor: 'semilla' });
    await casos.obtenerTarifa();
    await repoTarifas.sembrar(OTROS);
    expect(repoTarifas.versiones).toHaveLength(1);
    expect((await casos.obtenerTarifa()).bajadaCentavos).toBe(VALORES_PRUEBA.bajadaCentavos);
  });

  it('la estimación también siembra si todavía no hay tarifa', async () => {
    const { estimar, repoTarifas } = sistema();
    expect((await estimar()).tarifaVersion).toBe('v1');
    expect(repoTarifas.versiones).toHaveLength(1);
  });
});

describe('configurarTarifa', () => {
  it('crea una versión nueva con el autor del token y la auditoría de los valores anteriores y nuevos', async () => {
    const { casos, repoTarifas } = sistema();
    const nueva = await casos.configurarTarifa({ valores: OTROS, adminId: ADMIN });

    expect(nueva).toMatchObject({ version: 'v2', moneda: 'ARS', ...OTROS, actualizadaPor: ADMIN });
    expect(await casos.obtenerTarifa()).toMatchObject({ version: 'v2' });
    expect(repoTarifas.cambios).toEqual([
      { version: 'v1', versionAnterior: null, cambiadaPor: 'semilla', valoresAnteriores: null, valoresNuevos: VALORES_PRUEBA },
      { version: 'v2', versionAnterior: 'v1', cambiadaPor: ADMIN, valoresAnteriores: VALORES_PRUEBA, valoresNuevos: OTROS },
    ]);
  });

  it.each([
    ['fraccionario', { bajadaCentavos: 1.5 }],
    ['negativo', { centavosPorKm: -1 }],
    ['máximo en cero', { maxMetros: 0 }],
  ])('un valor %s se rechaza con TARIFA_INVALIDA y no crea versión', async (_caso, cambio) => {
    const { casos, repoTarifas } = sistema();
    await casos.obtenerTarifa();
    await expect(casos.configurarTarifa({ valores: { ...OTROS, ...cambio }, adminId: ADMIN })).rejects.toMatchObject({
      codigo: 'TARIFA_INVALIDA',
    });
    expect(repoTarifas.versiones).toHaveLength(1);
  });

  it('avisa al caché después de guardar: deja la nueva y borra la anterior', async () => {
    const { casos, cache } = sistema();
    await casos.obtenerTarifa();
    await casos.configurarTarifa({ valores: OTROS, adminId: ADMIN });
    expect(cache.operaciones).toEqual(['guardar v2', 'borrar v1']);
  });

  it('invalida la anterior que leyó la transacción, no la que se leyó antes de entrar', async () => {
    const { casos, cache, repoTarifas } = sistema();
    await casos.obtenerTarifa();
    // Otro admin guarda la v2 justo después de que este leyó la v1 y antes de su transacción.
    const reemplazarOriginal = repoTarifas.reemplazar.bind(repoTarifas);
    repoTarifas.reemplazar = async (valores, autor) => {
      await reemplazarOriginal(VALORES_PRUEBA, randomUUID());
      return reemplazarOriginal(valores, autor);
    };

    const nueva = await casos.configurarTarifa({ valores: OTROS, adminId: ADMIN });
    expect(nueva.version).toBe('v3');
    // Borra la v2 (la que reemplazó de verdad), no la v1 que había leído antes.
    expect(cache.operaciones).toEqual(['guardar v3', 'borrar v2']);
  });

  it('si el aviso al caché falla, el PUT igual responde la versión nueva', async () => {
    const { casos, cache } = sistema();
    cache.falla = { guardar: true, borrar: true };
    await expect(casos.configurarTarifa({ valores: OTROS, adminId: ADMIN })).resolves.toMatchObject({ version: 'v2' });
  });

  it('si guardar falla, no se avisa al caché (el aviso va después del COMMIT)', async () => {
    const { casos, cache, repoTarifas } = sistema();
    await casos.obtenerTarifa();
    repoTarifas.reemplazar = () => Promise.reject(new Error('Postgres caído'));
    await expect(casos.configurarTarifa({ valores: OTROS, adminId: ADMIN })).rejects.toThrow('Postgres caído');
    expect(cache.operaciones).toEqual([]);
  });
});

describe('estimación con caché', () => {
  it('MISS la primera vez, HIT después, y siempre con la versión vigente', async () => {
    const { estimar, lecturas, cache } = sistema();
    await estimar();
    await estimar();
    expect(lecturas).toEqual(['miss', 'hit']);
    expect(cache.entradas.has('v1')).toBe(true);
  });

  it('después de un PUT, la próxima estimación usa la tarifa nueva aunque el caché tenga la anterior', async () => {
    const { casos, estimar, cache } = sistema();
    const antes = await estimar();
    cache.falla = { guardar: true, borrar: true }; // la invalidación falla: v1 queda en el caché
    await casos.configurarTarifa({ valores: OTROS, adminId: ADMIN });
    cache.falla = {};

    const despues = await estimar();
    expect(antes.tarifaVersion).toBe('v1');
    expect(cache.entradas.has('v1')).toBe(true);
    expect(despues.tarifaVersion).toBe('v2');
    expect(despues.desglose.bajadaCentavos).toBe(OTROS.bajadaCentavos);
    // 300 000 + 5000 m × 60 000 / 1000 = 600 000 (el tiempo no cobra): por encima del mínimo de 400 000.
    expect(despues.tarifaCentavos).toBe(600_000);
  });

  it('si el caché falla al leer, estima con Postgres y cuenta el error', async () => {
    const { estimar, cache, lecturas } = sistema();
    cache.falla = { leer: true, guardar: true };
    const e = await estimar();
    expect(e.tarifaVersion).toBe('v1');
    expect(lecturas).toEqual(['error']);
  });

  it('una entrada que no es de la versión vigente no se usa', async () => {
    const { casos, estimar, cache } = sistema();
    await casos.configurarTarifa({ valores: OTROS, adminId: ADMIN });
    // Una lectura concurrente pudo dejar la v1 en el caché después del PUT: no importa, la clave es la versión.
    cache.entradas.set('v1', { version: 'v1', moneda: 'ARS', ...VALORES_PRUEBA });
    expect((await estimar()).tarifaVersion).toBe('v2');
  });
});
