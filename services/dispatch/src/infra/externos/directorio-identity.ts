import { ENCABEZADO_TOKEN_SERVICIO, UsuarioInterno } from '@viajes/contracts';
import { crearClienteInterno, ErrorHttp, ErrorServicioInterno, type ClienteInterno, type Logger } from '@viajes/platform';
import type { DirectorioUsuarios } from '../../dominio/puertos/index.js';

export interface OpcionesDirectorioIdentity {
  urlBase: string;
  tokenServicio: string;
  timeoutMs: number;
  logger: Logger;
}

/**
 * `DirectorioUsuarios` contra `GET /interno/usuarios/:id` de identity, con su token de servicio.
 * Es la información confiable sobre una cuenta: identity es el dueño de los roles, y la respuesta se
 * valida con el contrato (`UsuarioInterno`).
 * - 404 → la cuenta no existe (null).
 * - Timeout, red, 5xx, otro 4xx o respuesta fuera de contrato → 503 `IDENTITY_NO_DISPONIBLE`: falla
 *   cerrado, no se da de alta a nadie sin poder comprobarlo.
 */
export class DirectorioIdentity implements DirectorioUsuarios {
  private readonly cliente: ClienteInterno;

  constructor(private readonly opciones: OpcionesDirectorioIdentity) {
    this.cliente = crearClienteInterno({
      servicio: 'identity',
      urlBase: opciones.urlBase,
      timeoutMs: opciones.timeoutMs,
      encabezados: { [ENCABEZADO_TOKEN_SERVICIO]: opciones.tokenServicio },
    });
  }

  async rolDe(usuarioId: string): Promise<string | null> {
    try {
      const usuario = await this.cliente.getJson(`/interno/usuarios/${encodeURIComponent(usuarioId)}`, {}, UsuarioInterno);
      // Si identity devolviera otro id, no se confía en la respuesta.
      if (usuario.id !== usuarioId) throw new ErrorServicioInterno('identity', 'respuesta', 'devolvió otro usuario');
      return usuario.rol;
    } catch (err) {
      if (!(err instanceof ErrorServicioInterno)) throw err;
      if (err.motivo === 'estado' && err.estado === 404) return null;
      // Otro 4xx es un error de configuración de dispatch (token o contrato): más grave.
      const esNuestro = err.motivo === 'estado' && err.estado !== undefined && err.estado < 500;
      this.opciones.logger[esNuestro ? 'error' : 'warn'](
        { motivo: err.motivo, estado: err.estado, err: err.message },
        'identity: no se pudo verificar la cuenta',
      );
      throw new ErrorHttp(503, 'IDENTITY_NO_DISPONIBLE', 'No se puede verificar la cuenta en este momento');
    }
  }
}
