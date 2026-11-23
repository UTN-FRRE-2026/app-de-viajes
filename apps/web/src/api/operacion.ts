import { useRef } from 'react';
import { ErrorApi } from './errores';

/**
 * true si, después de este error, no se sabe si la operación se aplicó en el servidor: no hubo
 * respuesta, el servidor falló (5xx) o la misma clave todavía se está procesando. Se reintenta con la
 * MISMA `Idempotency-Key`: si ya se había aplicado, la API devuelve la respuesta de entonces.
 * Cualquier otro error es una respuesta definitiva (un 4xx): la operación no se aplicó.
 */
export function esIncierto(error: unknown): boolean {
  if (!(error instanceof ErrorApi)) return true;
  return error.estado === 0 || error.estado >= 500 || error.codigo === 'CLAVE_IDEMPOTENCIA_EN_CURSO';
}

/**
 * Las `Idempotency-Key` de las operaciones en curso, una por objetivo (`disponible:true`,
 * `aceptar:<ofertaId>`). La clave es de la operación, no del pedido:
 * - se crea en el primer intento y se reutiliza en cada reintento de ese mismo objetivo;
 * - se descarta cuando la operación sale bien o da un error definitivo;
 * - otro objetivo (otro cuerpo) lleva otra clave: con la misma, la API respondería 422.
 */
export class ClavesDeOperacion {
  private readonly claves = new Map<string, string>();

  constructor(private readonly crear: () => string = () => crypto.randomUUID()) {}

  /** La clave del objetivo: la misma hasta que la operación se cierre. */
  para(objetivo: string): string {
    let clave = this.claves.get(objetivo);
    if (!clave) {
      clave = this.crear();
      this.claves.set(objetivo, clave);
    }
    return clave;
  }

  cerrar(objetivo: string): void {
    this.claves.delete(objetivo);
  }

  /** Ejecuta la operación con su clave. Si el resultado es incierto, la clave queda para el reintento. */
  async ejecutar<T>(objetivo: string, hacer: (clave: string) => Promise<T>): Promise<T> {
    const clave = this.para(objetivo);
    try {
      const resultado = await hacer(clave);
      this.cerrar(objetivo);
      return resultado;
    } catch (err) {
      if (!esIncierto(err)) this.cerrar(objetivo);
      throw err;
    }
  }
}

/** Las claves de las operaciones de un componente (por ejemplo, un formulario). */
export function useClavesDeOperacion(): ClavesDeOperacion {
  const ref = useRef<ClavesDeOperacion | null>(null);
  ref.current ??= new ClavesDeOperacion();
  return ref.current;
}
