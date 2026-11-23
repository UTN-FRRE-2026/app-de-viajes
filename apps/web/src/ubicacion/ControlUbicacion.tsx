import { useState, type FormEvent } from 'react';
import { textoDeError } from '../componentes/MensajeError';
import { hace, useAhora } from '../componentes/useAhora';
import { estadoPosicion, leerCoordenadas, VIGENCIA_MS } from './posicion';
import type { EnvioUbicacion } from './useEnvioUbicacion';

/**
 * El envío de ubicación: GPS o manual (demo), y si se está enviando. `inactivo` explica por qué no se
 * envía (por ejemplo, «Ponete disponible para compartir tu ubicación»).
 */
export function ControlUbicacion({ envio, inactivo }: { envio: EnvioUbicacion; inactivo: string }) {
  const ahora = useAhora();
  const [lat, setLat] = useState(() => String(envio.fijacion?.lat ?? ''));
  const [lng, setLng] = useState(() => String(envio.fijacion?.lng ?? ''));
  const [invalida, setInvalida] = useState(false);

  const fijar = (e: FormEvent) => {
    e.preventDefault();
    const c = leerCoordenadas(lat, lng);
    setInvalida(!c);
    if (c) envio.fijarManual(c);
  };

  const estado = estadoPosicion(envio.fijacion, ahora);
  let linea: string;
  let alerta = false;
  if (!envio.activo) linea = inactivo;
  else if (estado.tipo === 'sin-posicion') linea = envio.modo === 'gps' ? 'Esperando la posición del GPS…' : 'Cargá las coordenadas para empezar a enviar.';
  else if (estado.tipo === 'vieja') {
    alerta = true;
    linea = `GPS sin posición reciente (${hace(estado.edadMs)}): no se envía.`;
    if (envio.ultimoEnvio && ahora - envio.ultimoEnvio > VIGENCIA_MS) linea += ' Ya no aparecés como disponible para nuevos viajes.';
  } else {
    linea = envio.ultimoEnvio ? `Enviando cada 5 s · último envío ${hace(ahora - envio.ultimoEnvio)}.` : 'Enviando…';
  }

  return (
    <div className="ubicacion">
      <div className="opciones" role="radiogroup" aria-label="Origen de la ubicación">
        <label className="opcion">
          <input type="radio" name="fuente" checked={envio.modo === 'gps'} onChange={() => envio.cambiarModo('gps')} /> GPS
        </label>
        <label className="opcion">
          <input type="radio" name="fuente" checked={envio.modo === 'manual'} onChange={() => envio.cambiarModo('manual')} /> Manual (demo)
        </label>
      </div>
      {envio.modo === 'manual' ? (
        <form className="coordenadas" onSubmit={fijar}>
          <label>
            Latitud
            <input inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />
          </label>
          <label>
            Longitud
            <input inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} />
          </label>
          <button type="submit">Usar estas coordenadas</button>
          {invalida ? <p className="error">Latitud entre -90 y 90, longitud entre -180 y 180.</p> : null}
        </form>
      ) : null}
      <p className={alerta ? 'error' : 'nota'} role="status">
        {linea}
      </p>
      {envio.errorGps ? <p className="error">{envio.errorGps}</p> : null}
      {envio.activo && envio.errorEnvio ? <p className="error">No se pudo enviar la ubicación: {textoDeError(envio.errorEnvio)}</p> : null}
    </div>
  );
}
