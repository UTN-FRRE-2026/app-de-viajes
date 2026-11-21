import { cargarConfig, crearLogger, registrarApagadoOrdenado } from '@viajes/platform';
import { componer } from './composicion.js';
import { EsquemaConfig } from './config/index.js';
import { iniciarBarrido } from './infra/barrido.js';

const config = cargarConfig(EsquemaConfig);
const logger = crearLogger('dispatch', config.NIVEL_LOG);
const sistema = componer(config, logger);
const detenerBarrido = iniciarBarrido(sistema.casos.vencerOfertas, config.BARRIDO_INTERVALO_MS, logger);
// El cobro de cada viaje completado: se procesa solo, sin que nadie lo pida. Si el proveedor no
// contesta, el cobro sigue PENDIENTE y el próximo barrido lo reintenta con la misma clave.
const detenerCobros = iniciarBarrido(() => sistema.casos.cobrarPendientes(), config.BARRIDO_INTERVALO_MS, logger, 'cobros procesados');

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
  alCerrar: [detenerBarrido, detenerCobros, sistema.cerrar],
});
