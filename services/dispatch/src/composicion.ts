import { fileURLToPath } from 'node:url';
import type { Reloj } from '@viajes/kernel';
import {
  AlmacenIdempotenciaMemoria,
  CerrojoMemoria,
  cerrojoRedis,
  crearApp,
  crearIdempotencia,
  crearMetricas,
  verificadorJwks,
  type AlmacenIdempotencia,
  type CerrojoEnVuelo,
  type ChequeoListo,
  type Logger,
  type VerificadorToken,
} from '@viajes/platform';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import { crearCasosDeFlotas, type CasosDeFlotas } from './dominio/casos-uso/flotas.js';
import { crearCasosDeUso, type CasosDeUso } from './dominio/casos-uso/index.js';
import type {
  BuscadorCandidatos,
  DirectorioUsuarios,
  ProcesadorPagos,
  ProveedorTarifas,
  RepositorioDespacho,
  RepositorioFlotas,
  RepositorioTarifas,
  ServicioMapas,
} from './dominio/puertos/index.js';
import type { Config } from './config/index.js';
import { crearPrisma } from './infra/db/cliente.js';
import { RepositorioDespachoPrisma } from './infra/db/repositorio-prisma.js';
import { RepositorioFlotasPrisma } from './infra/db/flotas-prisma.js';
import { AlmacenIdempotenciaPrisma, purgarIdempotenciaPrisma } from './infra/db/idempotencia-prisma.js';
import { chequeoRedis, chequeosBase } from './infra/db/salud.js';
import { BuscadorCandidatosFijo } from './infra/externos/buscador-fijo.js';
import { BuscadorCandidatosLocation } from './infra/externos/buscador-location.js';
import { DirectorioIdentity } from './infra/externos/directorio-identity.js';
import { MapasConTimeout } from './infra/externos/mapas-con-timeout.js';
import { MapasSimulado } from './infra/externos/mapas-simulado.js';
import { PagosConTimeout } from './infra/externos/pagos-con-timeout.js';
import { PagosSimulado } from './infra/externos/pagos-simulado.js';
import { idsAleatorios, relojSistema } from './infra/externos/sistema.js';
import { rutasDespacho } from './infra/http/rutas.js';
import { metricasDespachoPrometheus } from './infra/metricas/prometheus.js';
import { RepositorioDespachoMemoria } from './infra/memoria/repositorio-memoria.js';
import { RepositorioFlotasMemoria } from './infra/memoria/flotas-memoria.js';
import { RepositorioTarifasPrisma } from './infra/db/tarifas-prisma.js';
import { RepositorioTarifasMemoria } from './infra/memoria/tarifas-memoria.js';
import { contadorCacheTarifas } from './infra/metricas/prometheus.js';
import { cacheTarifasRedis, ProveedorTarifasVersionadas, type CacheTarifas } from './infra/tarifas/proveedor-tarifas.js';
import { semillaDesdeConfig } from './infra/tarifas/tarifas-config.js';
import { BusEventosMemoria } from './infra/tiempo-real/bus-memoria.js';
import { BusEventosRedis } from './infra/tiempo-real/bus-redis.js';
import { EventosMemoria } from './infra/tiempo-real/eventos-memoria.js';
import { HistorialEventosPrisma, relayOutboxPrisma } from './infra/tiempo-real/outbox-prisma.js';
import { PosicionesMemoria } from './infra/tiempo-real/posiciones-memoria.js';
import { PosicionesRedis } from './infra/tiempo-real/posiciones-redis.js';
import { StreamsEventos } from './infra/tiempo-real/sse.js';
import type { BusEventos, FuentePosiciones, HistorialEventos, RelayEventos } from './infra/tiempo-real/tipos.js';

/** Reemplazos para tests: cualquier adaptador se puede inyectar desde afuera. */
export interface Reemplazos {
  verificador?: VerificadorToken;
  buscador?: BuscadorCandidatos;
  reloj?: Reloj;
  repo?: RepositorioDespacho;
  /** El mapas de adentro: el timeout y la falla cerrado se aplican igual (para probar caídas). */
  mapas?: ServicioMapas;
  tarifas?: ProveedorTarifas;
  /** Sin este reemplazo, quien reemplaza el repo recibe la tarifa en memoria y sin caché. */
  repoTarifas?: RepositorioTarifas;
  cacheTarifas?: CacheTarifas | null;
  /** El proveedor de pagos de adentro: el timeout y la falla cerrado se aplican igual. */
  pagos?: ProcesadorPagos;
  /** Sin este reemplazo, quien reemplaza el repo recibe la idempotencia en memoria. */
  idempotencia?: { almacen: AlmacenIdempotencia; cerrojo: CerrojoEnVuelo };
  /** Sin este reemplazo, quien reemplaza el repo recibe un bus en memoria sin historial. */
  eventos?: TiempoReal;
  /** Sin este reemplazo, quien reemplaza el repo recibe las flotas en memoria. */
  repoFlotas?: RepositorioFlotas;
  /** Las cuentas de identity (el alta de choferes): en los tests, uno falso. */
  directorio?: DirectorioUsuarios;
}

/** El tiempo real: el bus en vivo, el historial para reponer, el relay del outbox y las posiciones de location. */
export interface TiempoReal {
  bus: BusEventos;
  historial: HistorialEventos;
  relay: RelayEventos;
  posiciones: FuentePosiciones;
}

export interface Sistema {
  app: Express;
  casos: CasosDeUso;
  casosFlotas: CasosDeFlotas;
  repo: RepositorioDespacho;
  repoFlotas: RepositorioFlotas;
  /** Lo corre el servidor cada RELAY_INTERVALO_MS; los tests, cuando lo necesitan. */
  relayEventos: RelayEventos;
  streams: StreamsEventos;
  /** Borra las claves de idempotencia vencidas; lo corre el servidor cada IDEMPOTENCIA_PURGA_INTERVALO_MS. */
  purgarIdempotencia: () => Promise<number>;
  cerrar: () => Promise<void>;
}

/** En memoria: sobre los eventos del repositorio en memoria, o vacío si el repo es otro. */
function tiempoRealEnMemoria(repo: RepositorioDespacho): TiempoReal {
  const bus = new BusEventosMemoria();
  const posiciones = new PosicionesMemoria();
  if (repo instanceof RepositorioDespachoMemoria) {
    const eventos = new EventosMemoria(repo, bus);
    return { bus, historial: eventos, relay: eventos.relay, posiciones };
  }
  return { bus, historial: { desde: async () => [] }, relay: async () => 0, posiciones };
}

const carpetaMigraciones = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

/**
 * Candidatos: location en serio, o la lista fija para una demo sin location. location no entra en
 * /ready: si se cae, el login y las consultas siguen; solo la búsqueda responde 503 (falla cerrado).
 */
function crearBuscador(config: Config, logger: Logger): BuscadorCandidatos {
  if (config.DISPATCH_BUSCADOR === 'fijo') return new BuscadorCandidatosFijo(config.DISPATCH_CANDIDATOS_DEMO);
  return new BuscadorCandidatosLocation({
    urlBase: config.LOCATION_URL as string,
    tokenServicio: config.LOCATION_TOKEN_SERVICIO as string,
    timeoutMs: config.LOCATION_TIMEOUT_MS,
    radioMetros: config.DISPATCH_RADIO_BUSQUEDA_METROS,
    logger,
  });
}

/** Falla rápido: si Redis no responde, el pedido contesta 503 enseguida en vez de quedar colgado. */
function crearRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 2000, commandTimeout: 1000 });
  redis.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis: error de conexión'));
  return redis;
}

/** Único lugar que conoce los adaptadores concretos. */
export function componer(config: Config, logger: Logger, reemplazos: Reemplazos = {}): Sistema {
  let repo: RepositorioDespacho;
  let chequeos: ChequeoListo[] = [];
  let cerrar = async () => {};
  let idempotencia = reemplazos.idempotencia ?? { almacen: new AlmacenIdempotenciaMemoria(), cerrojo: new CerrojoMemoria() };
  let repoTarifas: RepositorioTarifas = reemplazos.repoTarifas ?? new RepositorioTarifasMemoria();
  let cacheTarifas: CacheTarifas | null = reemplazos.cacheTarifas ?? null;
  let repoFlotas: RepositorioFlotas = reemplazos.repoFlotas ?? new RepositorioFlotasMemoria();

  let tiempoReal: TiempoReal | undefined = reemplazos.eventos;
  // En memoria no hace falta: el almacén vive lo que vive el proceso.
  let purgarIdempotencia = async () => 0;

  if (reemplazos.repo) {
    repo = reemplazos.repo;
  } else if (config.DISPATCH_PERSISTENCIA === 'memoria') {
    repo = new RepositorioDespachoMemoria();
  } else {
    const prisma = crearPrisma(config.DATABASE_URL as string, config.DB_POOL_MAX);
    const redis = crearRedis(config.REDIS_URL as string, logger);
    repo = new RepositorioDespachoPrisma(prisma);
    idempotencia = reemplazos.idempotencia ?? {
      almacen: new AlmacenIdempotenciaPrisma(prisma),
      cerrojo: cerrojoRedis(redis, 'dispatch:idempotencia:'),
    };
    purgarIdempotencia = purgarIdempotenciaPrisma(prisma, { retencionMs: config.IDEMPOTENCIA_RETENCION_HORAS * 3_600_000 });
    repoTarifas = reemplazos.repoTarifas ?? new RepositorioTarifasPrisma(prisma);
    repoFlotas = reemplazos.repoFlotas ?? new RepositorioFlotasPrisma(prisma);
    // El mismo Redis que la idempotencia. Tiempo límite corto: si no responde, se lee Postgres.
    cacheTarifas =
      reemplazos.cacheTarifas === undefined
        ? cacheTarifasRedis(redis, { prefijo: 'dispatch:tarifas:', ttlSegundos: config.TARIFAS_CACHE_TTL_SEGUNDOS, timeoutMs: 200 })
        : reemplazos.cacheTarifas;
    if (!tiempoReal) {
      const bus = new BusEventosRedis(redis, 'dispatch:eventos:', logger);
      tiempoReal = {
        bus,
        historial: new HistorialEventosPrisma(prisma),
        relay: relayOutboxPrisma(prisma, bus),
        // Los canales que publica location: mismo Redis y mismo LOCATION_REDIS_PREFIJO.
        posiciones: new PosicionesRedis(redis, config.LOCATION_REDIS_PREFIJO, logger),
      };
    }
    chequeos = [...chequeosBase(prisma, carpetaMigraciones), chequeoRedis(redis)];
    cerrar = async () => {
      redis.disconnect();
      await prisma.$disconnect();
    };
  }

  const eventos = tiempoReal ?? tiempoRealEnMemoria(repo);
  const streams = new StreamsEventos({
    bus: eventos.bus,
    historial: eventos.historial,
    logger,
    maxPorUsuario: config.SSE_MAX_POR_USUARIO,
    posiciones: { fuente: eventos.posiciones, viajeConChofer: (pasajeroId) => repo.viajeConChoferDelPasajero(pasajeroId) },
  });

  // Mapas siempre detrás del timeout: el simulado no lo necesita, pero un proveedor real sí, y así
  // la falla cerrado se prueba con el mismo código que va a envolver a ese proveedor.
  const mapas = new MapasConTimeout(
    reemplazos.mapas ??
      new MapasSimulado({
        factorDesvio: config.MAPAS_FACTOR_DESVIO,
        velocidadKmh: config.MAPAS_VELOCIDAD_KMH,
        latenciaMs: config.MAPAS_LATENCIA_SIMULADA_MS,
      }),
    config.MAPAS_TIMEOUT_MS,
    logger,
  );
  // Pagos, igual que mapas: siempre detrás del timeout, para que la falla cerrado sea el mismo código
  // con el simulado que con un proveedor real.
  const pagos = new PagosConTimeout(
    reemplazos.pagos ??
      new PagosSimulado({
        latenciaMs: config.PAGOS_LATENCIA_SIMULADA_MS,
        rechazarDesdeCentavos: config.PAGOS_RECHAZAR_DESDE_CENTAVOS ?? null,
      }),
    config.PAGOS_TIMEOUT_MS,
    logger,
  );
  // Los TARIFA_* del entorno solo son la semilla: crean la versión 1 si todavía no existe.
  const semillaTarifa = semillaDesdeConfig({
    bajadaCentavos: config.TARIFA_BAJADA_CENTAVOS,
    centavosPorKm: config.TARIFA_CENTAVOS_POR_KM,
    centavosPorMinuto: config.TARIFA_CENTAVOS_POR_MINUTO,
    minimoCentavos: config.TARIFA_MINIMO_CENTAVOS,
    maxMetros: config.TARIFA_MAX_METROS,
  });

  const metricas = crearMetricas({ servicio: 'dispatch' });
  const tarifas =
    reemplazos.tarifas ??
    new ProveedorTarifasVersionadas({
      repo: repoTarifas,
      semilla: semillaTarifa,
      cache: cacheTarifas,
      logger,
      alLeerCache: contadorCacheTarifas(metricas),
    });
  const casos = crearCasosDeUso({
    repo,
    buscador: reemplazos.buscador ?? crearBuscador(config, logger),
    reloj: reemplazos.reloj ?? relojSistema,
    ids: idsAleatorios,
    parametros: {
      ofertasSimultaneas: config.OFERTAS_SIMULTANEAS,
      ttlOfertaMs: config.OFERTA_TTL_SEGUNDOS * 1000,
    },
    metricas: metricasDespachoPrometheus(metricas),
    mapas,
    tarifas,
    pagos,
    repoTarifas,
    semillaTarifa,
  });

  // Flotas: el alta de un chofer verifica la cuenta en identity (falla cerrado si no responde).
  const casosFlotas = crearCasosDeFlotas({
    repoFlotas,
    directorio:
      reemplazos.directorio ??
      new DirectorioIdentity({
        urlBase: config.IDENTITY_URL,
        tokenServicio: config.IDENTITY_TOKEN_SERVICIO,
        timeoutMs: config.IDENTITY_TIMEOUT_MS,
        logger,
      }),
  });

  const verificador =
    reemplazos.verificador ??
    verificadorJwks(config.JWKS_URL, { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE });

  const app = crearApp({
    logger,
    rutas: rutasDespacho(
      casos,
      verificador,
      streams,
      crearIdempotencia({ ...idempotencia, ttlEnVueloMs: config.IDEMPOTENCIA_EN_VUELO_SEGUNDOS * 1000 }),
      casosFlotas,
    ),
    chequeos,
    metricas: { metricas, token: config.METRICAS_TOKEN },
    confiarEnProxy: config.CONFIAR_EN_PROXY,
  });
  const cerrarConexiones = cerrar;
  return {
    app,
    casos,
    casosFlotas,
    repo,
    repoFlotas,
    relayEventos: eventos.relay,
    streams,
    purgarIdempotencia,
    cerrar: async () => {
      metricas.detener();
      streams.cerrarTodos();
      await eventos.bus.cerrar();
      await eventos.posiciones.cerrar();
      await cerrarConexiones();
    },
  };
}
