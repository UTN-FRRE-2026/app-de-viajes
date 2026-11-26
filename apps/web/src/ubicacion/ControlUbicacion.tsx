import { useEffect, useState, type FormEvent } from 'react';
import { textoDeError } from '../componentes/MensajeError';
import { hace, useAhora } from '../componentes/useAhora';
import { estadoPosicion, leerCoordenadas, VIGENCIA_MS } from './posicion';
import type { EnvioUbicacion } from './useEnvioUbicacion';

/** Elegir la ubicación manual tocando el mapa: si se está eligiendo y cómo empezar o cancelar. */
export interface UbicarEnMapa {
  eligiendo: boolean;
  alternar(): void;
}

/**
 * El envío de ubicación: GPS o manual (demo), y si se está enviando. `inactivo` explica por qué no se
 * envía (por ejemplo, «Ponete disponible para compartir tu ubicación»). Con `enMapa`, el modo manual
 * ofrece además «Ubicarme en el mapa»; las coordenadas a mano siguen como alternativa.
 */
export function ControlUbicacion({ envio, inactivo, enMapa }: { envio: EnvioUbicacion; inactivo: string; enMapa?: UbicarEnMapa }) {
  const ahora = useAhora();
  const [lat, setLat] = useState(() => String(envio.fijacion?.lat ?? ''));
  const [lng, setLng] = useState(() => String(envio.fijacion?.lng ?? ''));
  const [invalida, setInvalida] = useState(false);

  // En manual, los campos muestran el punto fijado, venga de ellos mismos o de un toque en el mapa.
  const manualLat = envio.modo === 'manual' ? envio.fijacion?.lat : undefined;
  const manualLng = envio.modo === 'manual' ? envio.fijacion?.lng : undefined;
  useEffect(() => {
    if (manualLat === undefined || manualLng === undefined) return;
    setLat(String(manualLat));
    setLng(String(manualLng));
    setInvalida(false);
  }, [manualLat, manualLng]);

  const fijar = (e: FormEvent) => {
    e.preventDefault();
    const c = leerCoordenadas(lat, lng);
    setInvalida(!c);
    if (c) envio.fijarManual(c);
  };

  const estado = estadoPosicion(envio.fijacion, ahora);
  let linea: string | null;
  let alerta = false;
  if (!envio.activo) linea = inactivo;
  else if (estado.tipo === 'sin-posicion') {
    // Si el GPS ya falló (permiso denegado), «Esperando…» contradiría el error de abajo.
    if (envio.modo === 'gps') linea = envio.errorGps ? null : 'Esperando la posición del GPS…';
    else linea = 'Cargá las coordenadas para empezar a enviar.';
  }
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
      {envio.modo === 'manual' && enMapa ? (
        <button type="button" className={enMapa.eligiendo ? 'principal' : 'secundario'} aria-pressed={enMapa.eligiendo} onClick={enMapa.alternar}>
          {enMapa.eligiendo ? 'Ubicándome en el mapa… (cancelar)' : 'Ubicarme en el mapa'}
        </button>
      ) : null}
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
      {linea ? (
        <p className={alerta ? 'error' : 'nota'} role="status">
          {linea}
        </p>
      ) : null}
      {envio.errorGps ? <p className="error">{envio.errorGps}</p> : null}
      {envio.activo && envio.errorEnvio ? <p className="error">No se pudo enviar la ubicación: {textoDeError(envio.errorEnvio)}</p> : null}
    </div>
  );
}
