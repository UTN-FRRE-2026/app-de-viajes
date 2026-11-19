import { cargarConfig, crearLogger, registrarApagadoOrdenado } from '@viajes/platform';
import { componer } from './composicion.js';
import { EsquemaConfig } from './config/index.js';

const config = cargarConfig(EsquemaConfig);
const logger = crearLogger('location', config.NIVEL_LOG);
const sistema = componer(config, logger);

const servidor = sistema.app.listen(config.PUERTO, () => {
  logger.info({ puerto: config.PUERTO, estrategia: config.UBICACION_ESTRATEGIA }, 'location escuchando');
});

registrarApagadoOrdenado({
  servidor,
  logger,
  timeoutMs: config.APAGADO_TIMEOUT_MS,
  alCerrar: [sistema.cerrar],
});
