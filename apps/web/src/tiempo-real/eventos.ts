import { ErrorApi, errorDesdeRespuesta } from '../api/errores';
import { LectorSse } from './lector-sse';

export type EstadoConexion = 'conectando' | 'conectado' | 'reconectando' | 'detenido';

export interface OpcionesEventos {
  /** Cada evento, con su `data:` ya leído como JSON. Los que no son JSON válido se descartan. */
  alEvento(tipo: string, datos: unknown): void;
  /**
   * Cada vez que el stream queda abierto, también al reconectar. Ahí la pantalla relee su estado de la
   * API: lo que pasó mientras estaba desconectada no se repone (no se usa `Last-Event-ID`).
   */
  alConectar?(): void;
  alEstado?(estado: EstadoConexion, error: ErrorApi | null): void;
}

/** Lo que el cliente necesita de afuera; en los tests se reemplaza. */
export interface DependenciasEventos {
  fetch: typeof fetch;
  /** El access token vigente, o null si no hay sesión. */
  token(): string | null;
  /** Renueva el access token (una renovación compartida con los demás pedidos); null si no hay sesión. */
  renovar(): Promise<string | null>;
  /** Cambia cuando la sesión empieza o termina: con otra época, el stream se cierra. */
  epoca(): number;
  esperar(ms: number, senal: AbortSignal): Promise<void>;
  azar(): number;
}

export const RUTA_EVENTOS = '/api/viajes/eventos';
const ESPERA_INICIAL_MS = 3000;
const ESPERA_MAX_MS = 30_000;

export const esperar = (ms: number, senal: AbortSignal) =>
  new Promise<void>((resolver) => {
    if (senal.aborted) return resolver();
    const t = setTimeout(resolver, ms);
    senal.addEventListener('abort', () => (clearTimeout(t), resolver()), { once: true });
  });

/**
 * Abre `GET /api/viajes/eventos` con `fetch` (EventSource no deja mandar el `Authorization`, y el token
 * no va en la URL porque quedaría en los logs) y lo mantiene abierto. Devuelve la función que lo cierra.
 *
 * - **Reconexión:** si el stream se corta (vence el token, se reinicia dispatch), vuelve a conectar
 *   después del `retry:` del servidor (3 s), con un poco de azar. Si falla seguido, espera el doble
 *   cada vez, hasta 30 s.
 * - **401:** renueva el access token una vez y reconecta. Sin sesión, se detiene.
 * - **403:** se detiene (el rol no recibe eventos). **429** (`DEMASIADAS_CONEXIONES`, más de 3
 *   pestañas) y **503**: avisa con el error y espera.
 * - **Sin `Last-Event-ID`:** los eventos son avisos; la verdad está en la API, y `alConectar` la relee.
 * - Se cierra al cerrar la sesión (cambia la época) o al llamar a la función devuelta. Sigue abierto
 *   con la pestaña oculta: una oferta tiene que llegar igual.
 */
export function conectarEventos(o: OpcionesEventos, deps: DependenciasEventos): () => void {
  const control = new AbortController();
  const epoca = deps.epoca();
  const vigente = () => !control.signal.aborted && deps.epoca() === epoca;
  const estado = (e: EstadoConexion, error: ErrorApi | null = null) => {
    if (vigente() || e === 'detenido') o.alEstado?.(e, error);
  };
  const conAzar = (ms: number) => Math.round(ms * (0.8 + 0.4 * deps.azar()));

  void (async () => {
    let fallas = 0;
    let retry = ESPERA_INICIAL_MS;
    let renovado = false;
    /** Ya estuvo conectado: de ahí en adelante, cada intento es una reconexión. */
    let conecto = false;
    while (vigente()) {
      const token = deps.token();
      if (!token) break;
      estado(conecto || fallas > 0 ? 'reconectando' : 'conectando');

      let res: Response | null = null;
      try {
        res = await deps.fetch(RUTA_EVENTOS, {
          headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` },
          cache: 'no-store',
          signal: control.signal,
        });
      } catch {
        res = null;
      }
      if (!vigente()) break;

      if (res?.ok && res.body) {
        fallas = 0;
        renovado = false;
        conecto = true;
        estado('conectado');
        o.alConectar?.();
        const lector = new LectorSse();
        try {
          const lectura = res.body.pipeThrough(new TextDecoderStream()).getReader();
          for (;;) {
            const { value, done } = await lectura.read();
            if (done) break;
            for (const m of lector.agregar(value)) {
              let datos: unknown;
              try {
                datos = JSON.parse(m.datos);
              } catch {
                continue;
              }
              if (vigente()) o.alEvento(m.evento, datos);
            }
          }
        } catch {
          // Se cortó la conexión: se reconecta abajo.
        }
        if (lector.retry !== null) retry = lector.retry;
        if (!vigente()) break;
        estado('reconectando');
        await deps.esperar(conAzar(retry), control.signal);
        continue;
      }

      let error: ErrorApi | null = null;
      if (res) {
        if (res.status === 401 && !renovado) {
          renovado = true;
          const nuevo = await deps.renovar().catch(() => null);
          if (nuevo) continue;
          break; // sin sesión que renovar
        }
        error = await errorDesdeRespuesta(res);
        if (res.status === 403) {
          o.alEstado?.('detenido', error);
          return;
        }
      }
      fallas++;
      estado('reconectando', error);
      await deps.esperar(conAzar(Math.min(ESPERA_MAX_MS, retry * 2 ** (fallas - 1))), control.signal);
    }
    o.alEstado?.('detenido', null);
  })();

  return () => control.abort();
}
