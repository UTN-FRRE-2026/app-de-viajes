import type { z } from 'zod';

/** Por qué falló un pedido a otro servicio. Sirve para el log; al cliente nunca le llega. */
export type MotivoFalloInterno = 'timeout' | 'red' | 'estado' | 'respuesta';

/** Un pedido a otro servicio no terminó bien. El mensaje no incluye encabezados ni secretos. */
export class ErrorServicioInterno extends Error {
  constructor(
    readonly servicio: string,
    readonly motivo: MotivoFalloInterno,
    mensaje: string,
    readonly estado?: number,
  ) {
    super(`${servicio}: ${mensaje}`);
  }
}

export interface OpcionesClienteInterno {
  /** Nombre del servicio destino, para los errores y el log. */
  servicio: string;
  /** Base, por ejemplo `http://location:3004`. */
  urlBase: string;
  /** Tiempo máximo del pedido completo, incluida la lectura del cuerpo. */
  timeoutMs: number;
  /** Encabezados fijos de todos los pedidos (por ejemplo, el token de servicio). */
  encabezados?: Record<string, string>;
}

/**
 * Cliente HTTP para la comunicación entre servicios (Node 22, `fetch` nativo):
 * - **timeout siempre**: un servicio que no contesta no deja colgado al que lo llama;
 * - **valida la respuesta** con el esquema de `contracts`: si el otro servicio cambia el contrato,
 *   falla acá y no más adentro con datos raros;
 * - cualquier fallo (timeout, red, estado distinto de 2xx o cuerpo inválido) es un
 *   `ErrorServicioInterno`. Qué hacer con él (503, reintentar en el barrido) lo decide quien llama.
 */
export function crearClienteInterno({ servicio, urlBase, timeoutMs, encabezados = {} }: OpcionesClienteInterno) {
  return {
    async getJson<T extends z.ZodType>(
      ruta: string,
      query: Record<string, string | number>,
      esquema: T,
    ): Promise<z.infer<T>> {
      const url = new URL(ruta, urlBase);
      for (const [clave, valor] of Object.entries(query)) url.searchParams.set(clave, String(valor));

      const senal = AbortSignal.timeout(timeoutMs);
      let cuerpo: unknown;
      try {
        const res = await fetch(url, { headers: { accept: 'application/json', ...encabezados }, signal: senal });
        if (!res.ok) {
          // Se descarta el cuerpo para liberar la conexión; no se loguea (puede traer datos del otro servicio).
          await res.body?.cancel().catch(() => {});
          throw new ErrorServicioInterno(servicio, 'estado', `respondió ${res.status}`, res.status);
        }
        cuerpo = await res.json();
      } catch (err) {
        if (err instanceof ErrorServicioInterno) throw err;
        if (senal.aborted) throw new ErrorServicioInterno(servicio, 'timeout', `sin respuesta en ${timeoutMs} ms`);
        if (err instanceof SyntaxError) throw new ErrorServicioInterno(servicio, 'respuesta', 'el cuerpo no es JSON');
        throw new ErrorServicioInterno(servicio, 'red', err instanceof Error ? err.message : 'error de red');
      }

      const resultado = esquema.safeParse(cuerpo);
      if (!resultado.success) {
        throw new ErrorServicioInterno(servicio, 'respuesta', 'la respuesta no cumple el contrato');
      }
      return resultado.data;
    },
  };
}

export type ClienteInterno = ReturnType<typeof crearClienteInterno>;
