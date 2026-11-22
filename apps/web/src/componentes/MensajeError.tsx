import { ErrorApi } from '../api/errores';

/** Texto para mostrar: lo que dijo la API, con los casos comunes reescritos para el usuario. */
export function textoDeError(error: unknown): string {
  if (error instanceof ErrorApi) {
    if (error.estado === 0) return error.message;
    if (error.estado === 401) return 'Tu sesión terminó. Volvé a entrar.';
    if (error.estado === 403) return 'Esta acción no es para tu rol.';
    if (error.estado >= 500) return 'El servidor tuvo un problema. Probá de nuevo en un momento.';
    return error.message;
  }
  return 'Algo salió mal. Probá de nuevo.';
}

/**
 * Un error, con el `requestId` para poder buscarlo en el log del servicio. `onReintentar` repite la
 * MISMA operación: si llevaba Idempotency-Key, quien lo llama la reutiliza.
 */
export function MensajeError({ error, onReintentar }: { error: unknown; onReintentar?: () => void }) {
  const requestId = error instanceof ErrorApi ? error.requestId : null;
  const reintentable = !(error instanceof ErrorApi) || error.estado === 0 || error.estado >= 500;
  return (
    <div className="error" role="alert">
      <p>{textoDeError(error)}</p>
      {requestId ? <p className="nota">Código de seguimiento: {requestId}</p> : null}
      {onReintentar && reintentable ? (
        <button type="button" onClick={onReintentar}>
          Reintentar
        </button>
      ) : null}
    </div>
  );
}
