import { cargarConfig, crearLogger, registrarApagadoOrdenado } from '@viajes/platform';
import { componer } from './composicion.js';
import { EsquemaConfig } from './config/index.js';
import { iniciarBarrido } from './infra/barrido.js';

const config = cargarConfig(EsquemaConfig);
const logger = crearLogger('dispatch', config.NIVEL_LOG);
const sistema = componer(config, logger);
const detenerBarrido = iniciarBarrido(sistema.casos.vencerOfertas, config.BARRIDO_INTERVALO_MS, logger);

const servidor = sistema.app.listen(config.PUERTO, () => {
  logger.info({ puerto: config.PUERTO, persistencia: config.DISPATCH_PERSISTENCIA }, 'dispatch escuchando');
});

registrarApagadoOrdenado({
  servidor,
  logger,
  timeoutMs: config.APAGADO_TIMEOUT_MS,
  alCerrar: [detenerBarrido, sistema.cerrar],
});
