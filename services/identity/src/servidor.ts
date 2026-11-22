import { cargarConfig, crearLogger, iniciarBarrido, registrarApagadoOrdenado } from '@viajes/platform';
import { componer } from './composicion.js';
import { EsquemaConfig } from './config/index.js';

const config = cargarConfig(EsquemaConfig);
const logger = crearLogger('identity', config.NIVEL_LOG);
const sistema = componer(config, logger);
// Las respuestas guardadas por Idempotency-Key se borran pasada la retención, como en dispatch.
const detenerPurga = iniciarBarrido(
  sistema.purgarIdempotencia,
  config.IDEMPOTENCIA_PURGA_INTERVALO_MS,
  logger,
  'claves de idempotencia vencidas borradas',
);

const servidor = sistema.app.listen(config.PUERTO, () => {
  logger.info({ puerto: config.PUERTO, persistencia: config.IDENTITY_PERSISTENCIA }, 'identity escuchando');
});

registrarApagadoOrdenado({
  servidor,
  logger,
  timeoutMs: config.APAGADO_TIMEOUT_MS,
  alCerrar: [detenerPurga, sistema.cerrar],
});
