import { cargarConfig, crearLogger, iniciarBarrido, registrarApagadoOrdenado } from '@viajes/platform';
import { componer } from './composicion.js';
import { EsquemaConfig } from './config/index.js';

const config = cargarConfig(EsquemaConfig);
const logger = crearLogger('dispatch', config.NIVEL_LOG);
const sistema = componer(config, logger);
const detenerBarrido = iniciarBarrido(sistema.casos.vencerOfertas, config.BARRIDO_INTERVALO_MS, logger, 'ofertas vencidas procesadas');
// Tiempo real: publica en Redis lo nuevo del outbox. Su intervalo es la demora máxima de un evento.
const detenerRelay = iniciarBarrido(sistema.relayEventos, config.RELAY_INTERVALO_MS, logger, 'eventos publicados', 'debug');
// El cobro de cada viaje completado: se procesa solo, sin que nadie lo pida. Si el proveedor no
// contesta, el cobro sigue PENDIENTE y el próximo barrido lo reintenta con la misma clave.
const detenerCobros = iniciarBarrido(() => sistema.casos.cobrarPendientes(), config.BARRIDO_INTERVALO_MS, logger, 'cobros procesados');
// Las respuestas guardadas por Idempotency-Key se borran pasada la retención, para que la tabla no crezca sin límite.
const detenerPurga = iniciarBarrido(
  sistema.purgarIdempotencia,
  config.IDEMPOTENCIA_PURGA_INTERVALO_MS,
  logger,
  'claves de idempotencia vencidas borradas',
);
// Los eventos ya publicados del outbox, pasada OUTBOX_RETENCION_HORAS: si no, la tabla crece con cada evento.
const detenerPurgaOutbox = iniciarBarrido(sistema.purgarOutbox, config.IDEMPOTENCIA_PURGA_INTERVALO_MS, logger, 'eventos del outbox vencidos borrados');

const servidor = sistema.app.listen(config.PUERTO, () => {
  logger.info({ puerto: config.PUERTO, persistencia: config.DISPATCH_PERSISTENCIA, buscador: config.DISPATCH_BUSCADOR }, 'dispatch escuchando');
});

// Crea la versión 1 de la tarifa con los TARIFA_* del entorno si todavía no hay ninguna. Seguro ante
// reinicios y arranques simultáneos; si falla (por ejemplo, Postgres todavía no responde), la primera
// estimación o el GET del admin lo vuelven a intentar.
sistema.casos
  .obtenerTarifa()
  .then((t) => logger.info({ version: t.version, configuradaPor: t.actualizadaPor }, 'tarifa vigente'))
  .catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'tarifa: no se pudo leer al arrancar'));

registrarApagadoOrdenado({
  servidor,
  logger,
  timeoutMs: config.APAGADO_TIMEOUT_MS,
  // Los streams SSE no terminan solos: se cortan al empezar, y el cliente se reconecta a otra instancia.
  alEmpezar: [() => sistema.streams.cerrarTodos()],
  alCerrar: [detenerBarrido, detenerCobros, detenerRelay, detenerPurga, detenerPurgaOutbox, sistema.cerrar],
});
