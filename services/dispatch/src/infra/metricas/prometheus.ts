import { Counter, Histogram, type Metricas } from '@viajes/platform';
import type { MetricasDespacho } from '../../dominio/puertos/index.js';
import type { ResultadoCache } from '../tarifas/proveedor-tarifas.js';

function contadorCache({ registro }: Metricas, name: string, help: string): (resultado: ResultadoCache) => void {
  const lecturas = new Counter({ name, help, labelNames: ['resultado'] as const, registers: [registro] });
  for (const r of ['hit', 'miss', 'error'] as const) lecturas.inc({ resultado: r }, 0);
  return (resultado) => lecturas.inc({ resultado });
}

/** Caché de tarifas: HIT, MISS y errores (cuando Redis falla y se lee Postgres). */
export function contadorCacheTarifas(metricas: Metricas): (resultado: ResultadoCache) => void {
  return contadorCache(metricas, 'dispatch_tarifas_cache_total', 'Lecturas del caché de tarifas: hit, miss, o error (se usó Postgres).');
}

/** Caché de zonas: HIT, MISS y errores (cuando Redis falla y se lee Postgres). */
export function contadorCacheZonas(metricas: Metricas): (resultado: ResultadoCache) => void {
  return contadorCache(
    metricas,
    'dispatch_zonas_cache_total',
    'Lecturas del caché de zonas (polígonos y flotas de cada zona): hit, miss, o error (se usó Postgres).',
  );
}

/**
 * Ruteo (OSRM): `calles` (pedido a OSRM), `cache` (ya estaba) o `respaldo` (OSRM no respondió y se usó
 * la línea recta). Las tres arrancan en 0, para que la primera de cada una se vea en un `rate()`.
 */
export function contadorRuteo({ registro }: Metricas): (resultado: 'calles' | 'cache' | 'respaldo') => void {
  const rutas = new Counter({
    name: 'dispatch_ruteo_total',
    help: 'Rutas resueltas: calles (OSRM), cache, o respaldo (OSRM no respondió, línea recta).',
    labelNames: ['resultado'] as const,
    registers: [registro],
  });
  for (const r of ['calles', 'cache', 'respaldo'] as const) rutas.inc({ resultado: r }, 0);
  return (resultado) => rutas.inc({ resultado });
}

/** Métricas de negocio de dispatch, en el mismo Registry que las comunes de `platform`. */
export function metricasDespachoPrometheus({ registro }: Metricas): MetricasDespacho {
  const solicitudes = new Counter({
    name: 'dispatch_solicitudes_total',
    help: 'Solicitudes de viaje creadas, según si recibieron ofertas o quedaron SIN_CHOFERES.',
    labelNames: ['resultado'] as const,
    registers: [registro],
  });
  const asignaciones = new Counter({
    name: 'dispatch_asignaciones_total',
    help: 'Asignaciones confirmadas (una por solicitud: la aceptación ganadora).',
    registers: [registro],
  });
  const vencidas = new Counter({
    name: 'dispatch_ofertas_vencidas_total',
    help: 'Ofertas que el barrido marcó como vencidas.',
    registers: [registro],
  });
  // No es transaccional: cuenta búsquedas (cada una es una consulta a location y al filtro), aunque
  // después la transacción de la oferta no confirme.
  const sinAptos = new Counter({
    name: 'dispatch_busquedas_sin_aptos_total',
    help: 'Búsquedas de candidatos sin ningún apto: location no devolvió a nadie, el filtro de flotas y zonas descartó a todos, o descartó también los 100 más cercanos (tope_agotado).',
    labelNames: ['motivo'] as const,
    registers: [registro],
  });
  const hastaAsignacion = new Histogram({
    name: 'dispatch_tiempo_hasta_asignacion_seconds',
    help: 'Desde que el pasajero pide el viaje (antes de buscar candidatos) hasta el COMMIT de la aceptación.',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 45, 60],
    registers: [registro],
  });

  // Los contadores arrancan en 0 con cada resultado: así la serie existe antes del primer pedido.
  solicitudes.inc({ resultado: 'con_ofertas' }, 0);
  solicitudes.inc({ resultado: 'sin_choferes' }, 0);
  for (const motivo of ['sin_candidatos', 'filtrados', 'tope_agotado'] as const) sinAptos.inc({ motivo }, 0);

  return {
    solicitudCreada: (resultado) => solicitudes.inc({ resultado }),
    asignacion: (ms) => {
      asignaciones.inc();
      hastaAsignacion.observe(Math.max(0, ms) / 1000);
    },
    ofertasVencidas: (cantidad) => vencidas.inc(cantidad),
    busquedaSinAptos: (motivo) => sinAptos.inc({ motivo }),
  };
}
