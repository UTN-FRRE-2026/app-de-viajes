import { cargarConfig, crearLogger, registrarApagadoOrdenado } from '@viajes/platform';
import { componer } from './composicion.js';
import { EsquemaConfig } from './config/index.js';

const config = cargarConfig(EsquemaConfig);
const logger = crearLogger('location', config.NIVEL_LOG);
const sistema = componer(config, logger);

const servidor = sistema.app.listen(config.PUERTO, () => {
  logger.info({ puerto: config.PUERTO, estrategia: config.UBICACION_ESTRATEGIA }, 'location escuchando');
});
sistema.iniciar();

// Con SIGTERM: deja de aceptar conexiones, drena los pedidos y, en la versión optimizada, vacía el
// historial pendiente antes de cerrar Redis y Postgres.
registrarApagadoOrdenado({
  servidor,
  logger,
  timeoutMs: config.APAGADO_TIMEOUT_MS,
  alCerrar: [sistema.cerrar],
});
