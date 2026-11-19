import { RepositorioUbicacionesMemoria } from '../../src/infra/memoria/repositorio-memoria.js';
import { probarCasosDeUbicacion } from '../soporte/casos-compartidos.js';

probarCasosDeUbicacion('memoria', async () => new RepositorioUbicacionesMemoria());
