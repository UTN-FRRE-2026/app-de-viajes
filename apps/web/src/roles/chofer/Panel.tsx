import { useEffect } from 'react';
import { esIncierto } from '../../api/operacion';
import { ErrorApi } from '../../api/errores';
import { MensajeError, textoDeError } from '../../componentes/MensajeError';
import { useAhora } from '../../componentes/useAhora';
import type { EstadoConexion } from '../../tiempo-real/eventos';
import { useEventos } from '../../tiempo-real/useEventos';
import { ControlUbicacion } from '../../ubicacion/ControlUbicacion';
import { useEnvioUbicacion, type EnvioUbicacion } from '../../ubicacion/useEnvioUbicacion';
import { Posicion } from '../../viaje/Posicion';
import { distanciaMetros, ETIQUETA_ESTADO, pesos, textoDistancia, textoPunto, type OfertaPendiente } from '../../viaje/viaje';
import { ofertasVisibles, restanteMs, SIGUIENTE } from './logica';
import { useChofer } from './store';

const TEXTO_CONEXION: Record<EstadoConexion, string> = {
  conectando: 'Conectando…',
  conectado: 'En línea',
  reconectando: 'Reconectando…',
  detenido: 'Sin conexión',
};

/**
 * La pantalla del chofer: disponibilidad y ubicación, las ofertas (con su vencimiento) y el viaje activo.
 * Lo que muestra sale de `GET /chofer/estado`: se relee al abrir, al reconectar el stream y con cada
 * evento. Así, al recargar, el viaje activo y las ofertas pendientes vuelven solos.
 */
export function PanelChofer() {
  const cargado = useChofer((s) => s.cargado);
  const errorLectura = useChofer((s) => s.errorLectura);
  const viaje = useChofer((s) => s.viaje);
  const disponible = useChofer((s) => s.registro?.disponible ?? false);
  const aviso = useChofer((s) => s.aviso);

  useEffect(() => {
    const { reiniciar, releer } = useChofer.getState();
    reiniciar();
    void releer();
    return () => useChofer.getState().reiniciar();
  }, []);

  const conexion = useEventos({
    alEvento: (tipo, datos) => useChofer.getState().evento(tipo, datos),
    alConectar: () => void useChofer.getState().releer(),
  });
  // La ubicación se envía si está disponible o tiene un viaje: sin envíos, a los 30 s deja de ser candidato.
  const envio = useEnvioUbicacion('/ubicacion/ubicaciones', disponible || viaje !== null);

  if (!cargado) {
    return errorLectura ? (
      <section className="tarjeta">
        <MensajeError error={errorLectura} onReintentar={() => void useChofer.getState().releer()} />
      </section>
    ) : (
      <p className="cargando">Cargando…</p>
    );
  }

  return (
    <div className="panel">
      <section className="tarjeta">
        <div className="encabezado">
          <h1>Chofer</h1>
          <span className={`conexion ${conexion.estado}`} role="status">
            {TEXTO_CONEXION[conexion.estado]}
          </span>
        </div>
        {conexion.error ? <p className="error">{textoDeError(conexion.error)}</p> : null}
        <Disponibilidad />
        <ControlUbicacion envio={envio} inactivo="Ponete disponible para compartir tu ubicación y recibir ofertas." />
      </section>

      {aviso ? (
        <div className="aviso" role="status">
          <p>{aviso}</p>
          <button type="button" onClick={() => useChofer.getState().cerrarAviso()}>
            Entendido
          </button>
        </div>
      ) : null}
      {errorLectura ? <MensajeError error={errorLectura} onReintentar={() => void useChofer.getState().releer()} /> : null}

      <Resumen />
      {viaje ? <ViajeActivo envio={envio} /> : <Ofertas envio={envio} />}
    </div>
  );
}

const TEXTO_DISPONIBILIDAD: Record<string, string> = {
  CHOFER_NO_ENCONTRADO: 'Tu usuario no está en una flota: pedile al admin de tu flota que te dé de alta.',
  CHOFER_NO_ACTIVO: 'Tu flota todavía no te activó.',
};

function Disponibilidad() {
  const registro = useChofer((s) => s.registro);
  const cambio = useChofer((s) => s.disponibilidad);
  const cambiar = useChofer((s) => s.cambiarDisponible);

  let motivo: string | null = null;
  if (!registro) motivo = TEXTO_DISPONIBILIDAD['CHOFER_NO_ENCONTRADO']!;
  else if (!registro.habilitado) motivo = 'Falta que la plataforma te habilite.';
  else if (!registro.activo) motivo = TEXTO_DISPONIBILIDAD['CHOFER_NO_ACTIVO']!;
  const disponible = registro?.disponible ?? false;
  const error = cambio.error;
  const textoError = error instanceof ErrorApi ? TEXTO_DISPONIBILIDAD[error.codigo] : undefined;

  return (
    <div className="disponibilidad">
      <p>
        {disponible ? <strong className="ok">Disponible</strong> : <strong>No disponible</strong>}
        {registro ? <span className="nota"> · {registro.vehiculo.marca} {registro.vehiculo.modelo} ({registro.vehiculo.patente})</span> : null}
      </p>
      {motivo && !disponible ? (
        <p className="nota">{motivo}</p>
      ) : (
        <button type="button" disabled={cambio.enviando} onClick={() => void cambiar(!disponible)}>
          {cambio.enviando ? 'Guardando…' : disponible ? 'Dejar de estar disponible' : 'Ponerme disponible'}
        </button>
      )}
      {error && !cambio.enviando ? (
        textoError ? (
          <p className="error">{textoError}</p>
        ) : (
          <div>
            <MensajeError error={error} />
            {esIncierto(error) && cambio.valor !== null ? (
              <button type="button" onClick={() => void cambiar(cambio.valor as boolean)}>
                Reintentar
              </button>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

function Ofertas({ envio }: { envio: EnvioUbicacion }) {
  const ahora = useAhora(500);
  const estado = useChofer();
  const visibles = ofertasVisibles(estado, ahora);
  const { aceptacion, registro } = estado;

  return (
    <section className="tarjeta">
      <h2>Ofertas</h2>
      {aceptacion ? (
        <div className="oferta resaltada">
          <DatosOferta oferta={aceptacion.oferta} desde={envio.fijacion} />
          {aceptacion.fase === 'enviando' ? (
            <p className="nota">Aceptando…</p>
          ) : (
            <>
              <p className="error">No sabemos si se aceptó la oferta: no llegó la respuesta.</p>
              <MensajeError error={aceptacion.error} />
              <button type="button" onClick={() => estado.reintentarAceptacion()}>
                Reintentar
              </button>
            </>
          )}
        </div>
      ) : null}
      {visibles.map((o) => {
        const restante = restanteMs(o, ahora, estado.desfaseMs);
        const vencida = restante <= 0;
        return (
          <div key={o.ofertaId} className={vencida ? 'oferta vencida' : 'oferta'}>
            <DatosOferta oferta={o} desde={envio.fijacion} />
            <div className="acciones">
              <span className={vencida ? 'error' : 'cuenta'}>{vencida ? 'Venció' : `Vence en ${Math.ceil(restante / 1000)} s`}</span>
              <button type="button" disabled={vencida || aceptacion !== null} onClick={() => estado.aceptar(o)}>
                Aceptar
              </button>
            </div>
          </div>
        );
      })}
      {!aceptacion && visibles.length === 0 ? (
        <p className="nota">{registro?.disponible ? 'Esperando ofertas…' : 'No estás disponible: no vas a recibir ofertas.'}</p>
      ) : null}
    </section>
  );
}

function DatosOferta({ oferta, desde }: { oferta: OfertaPendiente; desde: { lat: number; lng: number } | null }) {
  return (
    <div className="datos">
      <p>
        <strong>Origen:</strong> {textoPunto(oferta.origen)}
        {desde ? <span className="nota"> · a {textoDistancia(distanciaMetros(desde, oferta.origen))} de vos</span> : null}
      </p>
      <p>
        <strong>Destino:</strong> {textoPunto(oferta.destino)}
      </p>
      {oferta.tarifaEstimadaCentavos !== null ? (
        <p>
          <strong>Tarifa estimada:</strong> {pesos(oferta.tarifaEstimadaCentavos)}
        </p>
      ) : null}
    </div>
  );
}

function ViajeActivo({ envio }: { envio: EnvioUbicacion }) {
  const viaje = useChofer((s) => s.viaje);
  const operacion = useChofer((s) => s.operacion);
  const posicion = useChofer((s) => s.posicionPasajero);
  const desfaseMs = useChofer((s) => s.desfaseMs);
  if (!viaje) return null;
  const siguiente = SIGUIENTE[viaje.estado];

  return (
    <section className="tarjeta">
      <div className="encabezado">
        <h2>Viaje</h2>
        <span className="etiqueta">{ETIQUETA_ESTADO[viaje.estado]}</span>
      </div>
      <p>
        <strong>Origen:</strong> {textoPunto(viaje.origen)}
      </p>
      <p>
        <strong>Destino:</strong> {textoPunto(viaje.destino)}
      </p>
      {viaje.tarifa ? (
        <p>
          <strong>Tarifa estimada:</strong> {pesos(viaje.tarifa.estimadaCentavos)}
        </p>
      ) : null}
      <Posicion titulo="Pasajero" posicion={posicion} referencia={envio.fijacion} desfaseMs={desfaseMs} />
      {siguiente ? (
        <button type="button" disabled={operacion !== null} onClick={() => useChofer.getState().avanzar()}>
          {operacion?.fase === 'enviando' ? 'Enviando…' : siguiente.texto}
        </button>
      ) : null}
      {operacion?.fase === 'incierta' ? (
        <div>
          <p className="error">No sabemos si se registró: no llegó la respuesta.</p>
          <MensajeError error={operacion.error} />
          <button type="button" onClick={() => useChofer.getState().reintentarOperacion()}>
            Reintentar
          </button>
        </div>
      ) : null}
    </section>
  );
}

function Resumen() {
  const terminado = useChofer((s) => s.terminado);
  if (!terminado) return null;
  const final = terminado.tarifa?.finalCentavos ?? null;
  return (
    <section className="tarjeta resumen" role="status">
      <h2>Viaje terminado</h2>
      {final !== null ? (
        <p>
          Tarifa final: <strong>{pesos(final)}</strong>
        </p>
      ) : null}
      <button type="button" onClick={() => useChofer.getState().cerrarResumen()}>
        Listo
      </button>
    </section>
  );
}
