import type { Logger } from '@viajes/platform';
import type { Redis } from 'ioredis';
import type { ProveedorTarifas, RepositorioTarifas } from '../../dominio/puertos/index.js';
import { problemasDeParametros, type ParametrosTarifa, type ValoresTarifa } from '../../dominio/tarifas/parametros.js';

/** Caché de los parámetros de una versión. Las versiones no cambian nunca: una entrada nunca queda vieja. */
export interface CacheTarifas {
  leer(version: string): Promise<ParametrosTarifa | null>;
  guardar(parametros: ParametrosTarifa): Promise<void>;
  borrar(version: string): Promise<void>;
}

export type ResultadoCache = 'hit' | 'miss' | 'error';

const soloParametros = (t: ParametrosTarifa): ParametrosTarifa => ({
  version: t.version,
  moneda: t.moneda,
  bajadaCentavos: t.bajadaCentavos,
  centavosPorKm: t.centavosPorKm,
  centavosPorMinuto: t.centavosPorMinuto,
  minimoCentavos: t.minimoCentavos,
  maxMetros: t.maxMetros,
});

function conTiempoLimite<T>(promesa: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const vencido = new Promise<never>((_, rechazar) => {
    timer = setTimeout(() => rechazar(new Error(`caché sin respuesta en ${ms} ms`)), ms);
  });
  return Promise.race([promesa, vencido]).finally(() => clearTimeout(timer));
}

/**
 * Caché en Redis, por versión: `<prefijo>v3` → parámetros en JSON, con TTL. Cada operación tiene un
 * tiempo límite corto: si Redis tarda o no responde, se lee Postgres y la estimación no espera.
 * Lo que vuelve del caché se valida: una entrada rota cuenta como MISS.
 */
export function cacheTarifasRedis(redis: Redis, opciones: { prefijo: string; ttlSegundos: number; timeoutMs: number }): CacheTarifas {
  const clave = (version: string) => `${opciones.prefijo}${version}`;
  return {
    async leer(version) {
      const texto = await conTiempoLimite(redis.get(clave(version)), opciones.timeoutMs);
      if (!texto) return null;
      try {
        const p = JSON.parse(texto) as ParametrosTarifa;
        return p.version === version && p.moneda === 'ARS' && problemasDeParametros(p).length === 0 ? soloParametros(p) : null;
      } catch {
        return null;
      }
    },
    async guardar(p) {
      await conTiempoLimite(redis.set(clave(p.version), JSON.stringify(soloParametros(p)), 'EX', opciones.ttlSegundos), opciones.timeoutMs);
    },
    async borrar(version) {
      await conTiempoLimite(redis.del(clave(version)), opciones.timeoutMs);
    },
  };
}

export interface OpcionesProveedorTarifas {
  repo: RepositorioTarifas;
  /** Los `TARIFA_*` del entorno: solo crean la versión 1 si todavía no hay ninguna. */
  semilla: ValoresTarifa;
  /** null en el modo memoria: no hay Redis. */
  cache: CacheTarifas | null;
  logger: Logger;
  /** Para las métricas: HIT, MISS o error del caché. */
  alLeerCache?: (resultado: ResultadoCache) => void;
}

/**
 * Lo que usa la estimación. En cada consulta:
 * 1. Pregunta a Postgres **qué versión está vigente** (una fila por clave primaria). Esto nunca sale
 *    del caché: así, después de un PUT, la próxima estimación ya ve la versión nueva, aunque haya
 *    fallado la invalidación o una lectura concurrente haya llenado el caché con la versión anterior.
 * 2. Busca los parámetros de esa versión en Redis (HIT) o en Postgres (MISS), y los deja en Redis.
 *    Si Redis falla, sigue con Postgres: el caché nunca es un punto de falla.
 */
export class ProveedorTarifasVersionadas implements ProveedorTarifas {
  constructor(private readonly o: OpcionesProveedorTarifas) {}

  async vigente(): Promise<ParametrosTarifa> {
    const version = await this.versionVigente();

    if (this.o.cache) {
      try {
        const guardada = await this.o.cache.leer(version);
        this.o.alLeerCache?.(guardada ? 'hit' : 'miss');
        if (guardada) return guardada;
      } catch (err) {
        this.o.alLeerCache?.('error');
        this.avisar('lectura', err);
      }
    }

    const tarifa = await this.o.repo.porVersion(version);
    if (!tarifa) throw new Error(`tarifas: la versión vigente ${version} no existe`);
    const parametros = soloParametros(tarifa);
    if (this.o.cache) await this.o.cache.guardar(parametros).catch((err: unknown) => this.avisar('escritura', err));
    return parametros;
  }

  /** Después del COMMIT de un PUT: deja la nueva en el caché y borra la anterior. Higiene, no corrección. */
  async tarifaCambiada(anterior: string | null, nueva: ParametrosTarifa): Promise<void> {
    if (!this.o.cache) return;
    try {
      await this.o.cache.guardar(soloParametros(nueva));
      if (anterior && anterior !== nueva.version) await this.o.cache.borrar(anterior);
    } catch (err) {
      this.avisar('invalidación', err);
    }
  }

  private async versionVigente(): Promise<string> {
    const version = await this.o.repo.versionVigente();
    if (version) return version;
    await this.o.repo.sembrar(this.o.semilla);
    const sembrada = await this.o.repo.versionVigente();
    if (!sembrada) throw new Error('tarifas: no hay versión vigente después de sembrar');
    return sembrada;
  }

  private avisar(que: string, err: unknown) {
    this.o.logger.warn({ err: err instanceof Error ? err.message : String(err) }, `tarifas: falló la ${que} del caché; se usa Postgres`);
  }
}
