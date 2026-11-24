import { useEffect, useState } from 'react';
import { MensajeError, textoDeError } from '../../componentes/MensajeError';
import { hace, useAhora } from '../../componentes/useAhora';
import { Mapa } from '../../mapa/Mapa';
import type { EstadoConexion } from '../../tiempo-real/eventos';
import { useEventos } from '../../tiempo-real/useEventos';
import { ControlUbicacion } from '../../ubicacion/ControlUbicacion';
import { VIGENCIA_MS } from '../../ubicacion/posicion';
import { useEnvioUbicacion } from '../../ubicacion/useEnvioUbicacion';
import { distanciaMetros, ETIQUETA_ESTADO, pesos, textoDistancia, type Punto } from '../../viaje/viaje';
import { esActivo, lineaDeTiempo, type ItemLinea } from './logica';
import { LUGARES, lugarEn, nombrePunto } from './lugares';
import { usePasajero } from './store';

const TEXTO_CONEXION: Record<EstadoConexion, string> = {
  conectando: 'Conectando…',
  conectado: 'En vivo',
  reconectando: 'Reconectando…',
  detenido: 'Sin conexión',
};

const HORA = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

type Campo = 'origen' | 'destino';

/**
 * La pantalla del pasajero, con la línea de tiempo del viaje como eje: cada evento que llega por el
 * SSE prende un paso con la hora en que llegó. Lo que muestra sale del historial (`GET /historial`):
 * se relee al abrir, al reconectar el stream y con cada evento. Al recargar, el viaje activo vuelve solo.
 */
export function PanelPasajero() {
  const cargado = usePasajero((s) => s.cargado);
  const errorLectura = usePasajero((s) => s.errorLectura);
  const viaje = usePasajero((s) => s.viaje);
  const posicionChofer = usePasajero((s) => s.posicionChofer);

  // El recorrido que se está armando (sin viaje en pantalla).
  const [origen, setOrigen] = useState<Punto | null>(null);
  const [destino, setDestino] = useState<Punto | null>(null);
  const [marcando, setMarcando] = useState<Campo | null>('origen');

  useEffect(() => {
    const { reiniciar, releer } = usePasajero.getState();
    reiniciar();
    void releer();
    return () => usePasajero.getState().reiniciar();
  }, []);

  useEffect(() => {
    void usePasajero.getState().estimar(origen, destino);
  }, [origen, destino]);

  const conexion = useEventos({
    alEvento: (tipo, datos) => usePasajero.getState().evento(tipo, datos),
    alConectar: () => void usePasajero.getState().releer(),
  });

  // Hasta que lo pasa a buscar, el pasajero comparte su posición con el chofer asignado.
  const compartir = viaje !== null && (viaje.estado === 'ASIGNADO' || viaje.estado === 'EN_CAMINO');
  const envio = useEnvioUbicacion('/ubicacion/ubicaciones/pasajero', compartir);

  const ahora = useAhora();
  const movilVieja = posicionChofer !== null && ahora - Date.parse(posicionChofer.actualizadaEn) > VIGENCIA_MS;

  const fijar = (campo: Campo, p: Punto) => {
    if (campo === 'origen') {
      setOrigen(p);
      // Elegido el origen, el próximo clic en el mapa es el destino (si todavía no hay).
      setMarcando(destino ? null : 'destino');
    } else {
      setDestino(p);
      setMarcando(null);
    }
  };

  if (!cargado) {
    return errorLectura ? (
      <section className="tarjeta angosto-centrado">
        <MensajeError error={errorLectura} onReintentar={() => void usePasajero.getState().releer()} />
      </section>
    ) : (
      <p className="cargando">Cargando…</p>
    );
  }

  const marcas = viaje
    ? { origen: viaje.origen, destino: viaje.destino, movil: posicionChofer, movilVieja }
    : { origen, destino };

  return (
    <div className="pasajero ancho">
      <section className="tarjeta columna-viaje" aria-labelledby="titulo-viaje">
        <div className="encabezado">
          <h1 id="titulo-viaje">{viaje ? 'Tu viaje' : 'Pedir un viaje'}</h1>
          <span className={`conexion ${conexion.estado}`} role="status">
            {TEXTO_CONEXION[conexion.estado]}
          </span>
        </div>
        {conexion.error ? <p className="error">{textoDeError(conexion.error)}</p> : null}
        <Aviso />
        {errorLectura ? <MensajeError error={errorLectura} onReintentar={() => void usePasajero.getState().releer()} /> : null}
        {viaje ? (
          <LineaTiempo />
        ) : (
          <Recorrido origen={origen} destino={destino} marcando={marcando} setMarcando={setMarcando} fijar={fijar} />
        )}
      </section>

      <section className="zona-mapa" aria-label="Mapa">
        <Mapa
          marcas={marcas}
          etiqueta={viaje ? 'Mapa del viaje' : 'Mapa para elegir origen y destino'}
          alTocar={!viaje && marcando ? (p) => fijar(marcando, p) : undefined}
        />
        {!viaje ? (
          <p className="nota ayuda-mapa" role="status">
            {marcando ? `Tocá el mapa para marcar el ${marcando}.` : 'Elegí «Marcar en el mapa» para cambiar un punto.'}
          </p>
        ) : null}
      </section>

      <aside className="tarjeta columna-detalle" aria-label="Detalle">
        {viaje ? <DetalleViaje envio={envio} /> : <Estimacion origen={origen} destino={destino} />}
      </aside>
    </div>
  );
}

function Aviso() {
  const aviso = usePasajero((s) => s.aviso);
  if (!aviso) return null;
  return (
    <div className="aviso" role="status">
      <p>{aviso}</p>
      <button type="button" className="secundario" onClick={() => usePasajero.getState().cerrarAviso()}>
        Entendido
      </button>
    </div>
  );
}

/** La línea de tiempo: los pasos del viaje, el actual resaltado, cada uno con la hora en que llegó. */
function LineaTiempo() {
  const estado = usePasajero();
  const ahora = useAhora();
  const items = lineaDeTiempo(estado);
  return (
    <ol className="linea-tiempo">
      {items.map((it) => (
        <PasoLinea key={it.clave} item={it} ahora={ahora} />
      ))}
    </ol>
  );
}

function PasoLinea({ item, ahora }: { item: ItemLinea; ahora: number }) {
  const { titulo, estado, hora, detalle } = item;
  return (
    <li className={`paso ${estado}`} aria-current={estado === 'actual' ? 'step' : undefined}>
      <strong>{titulo}</strong>
      {hora !== null ? (
        <span className="hora">
          <time dateTime={new Date(hora).toISOString()}>{HORA.format(hora)}</time>
          {estado === 'actual' ? ` · ${hace(ahora - hora)}` : null}
        </span>
      ) : null}
      {detalle ? <span className="detalle-paso">{detalle}</span> : null}
    </li>
  );
}

/** Origen y destino: lugares de la demo, «usar mi ubicación» o un clic en el mapa. */
function Recorrido({
  origen,
  destino,
  marcando,
  setMarcando,
  fijar,
}: {
  origen: Punto | null;
  destino: Punto | null;
  marcando: Campo | null;
  setMarcando: (c: Campo | null) => void;
  fijar: (c: Campo, p: Punto) => void;
}) {
  return (
    <div className="recorrido">
      <PuntoCampo campo="origen" valor={origen} marcando={marcando === 'origen'} setMarcando={setMarcando} fijar={fijar} />
      <PuntoCampo campo="destino" valor={destino} marcando={marcando === 'destino'} setMarcando={setMarcando} fijar={fijar} />
      <p className="nota">Los lugares de la lista están dentro de la zona de la demo.</p>
    </div>
  );
}

function PuntoCampo({
  campo,
  valor,
  marcando,
  setMarcando,
  fijar,
}: {
  campo: Campo;
  valor: Punto | null;
  marcando: boolean;
  setMarcando: (c: Campo | null) => void;
  fijar: (c: Campo, p: Punto) => void;
}) {
  const [gps, setGps] = useState<{ buscando: boolean; error: string | null }>({ buscando: false, error: null });
  const titulo = campo === 'origen' ? 'Origen' : 'Destino';
  const conocido = valor ? LUGARES.find((l) => lugarEn(valor) === l.nombre) : undefined;
  const seleccion = !valor ? '' : (conocido?.id ?? 'mapa');

  const usarMiUbicacion = () => {
    if (!('geolocation' in navigator)) {
      setGps({ buscando: false, error: 'Este navegador no da la ubicación.' });
      return;
    }
    setGps({ buscando: true, error: null });
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setGps({ buscando: false, error: null });
        fijar(campo, { lat: p.coords.latitude, lng: p.coords.longitude });
      },
      (e) =>
        setGps({
          buscando: false,
          error: e.code === e.PERMISSION_DENIED ? 'No diste permiso para usar la ubicación.' : 'No se pudo obtener la ubicación.',
        }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  };

  return (
    <fieldset className={`punto ${campo}${marcando ? ' marcando' : ''}`}>
      <legend>{titulo}</legend>
      <select
        aria-label={titulo}
        value={seleccion}
        onChange={(e) => {
          const l = LUGARES.find((x) => x.id === e.target.value);
          if (l) fijar(campo, { lat: l.lat, lng: l.lng });
        }}
      >
        <option value="" disabled>
          Elegí un lugar…
        </option>
        {LUGARES.map((l) => (
          <option key={l.id} value={l.id}>
            {l.nombre}
          </option>
        ))}
        {seleccion === 'mapa' && valor ? <option value="mapa">Punto marcado en el mapa</option> : null}
      </select>
      <div className="acciones-punto">
        <button type="button" className="enlace" aria-pressed={marcando} onClick={() => setMarcando(marcando ? null : campo)}>
          {marcando ? 'Marcando en el mapa…' : 'Marcar en el mapa'}
        </button>
        {campo === 'origen' ? (
          <button type="button" className="enlace" disabled={gps.buscando} onClick={usarMiUbicacion}>
            {gps.buscando ? 'Buscando tu ubicación…' : 'Usar mi ubicación'}
          </button>
        ) : null}
      </div>
      {gps.error ? <p className="error">{gps.error}</p> : null}
    </fieldset>
  );
}

/** Sin viaje: la estimación del recorrido elegido y el botón para pedir. */
function Estimacion({ origen, destino }: { origen: Punto | null; destino: Punto | null }) {
  const estimacion = usePasajero((s) => s.estimacion);
  const pedido = usePasajero((s) => s.pedido);
  const errorPedido = usePasajero((s) => s.errorPedido);
  const listo = origen !== null && destino !== null && estimacion?.datos != null && !estimacion.cargando;

  return (
    <div className="detalle">
      <h2>Estimación</h2>
      {!origen || !destino ? (
        <p className="nota">Elegí el origen y el destino para ver cuánto sale.</p>
      ) : estimacion?.cargando ? (
        <p className="nota">Calculando…</p>
      ) : estimacion?.error ? (
        <MensajeError error={estimacion.error} onReintentar={() => void usePasajero.getState().estimar(origen, destino)} />
      ) : estimacion?.datos ? (
        <>
          <p className="monto">{pesos(estimacion.datos.tarifaCentavos)}</p>
          <p className="nota">
            {textoDistancia(estimacion.datos.distanciaMetros)} · {Math.max(1, Math.round(estimacion.datos.duracionSegundos / 60))} min
            {estimacion.datos.desglose.minimoAplicado ? ' · tarifa mínima' : ''}
          </p>
          <p className="nota">La tarifa final se calcula con el recorrido real y puede ser distinta.</p>
        </>
      ) : null}

      {origen && destino ? (
        <dl className="datos-viaje">
          <dt>Desde</dt>
          <dd>{nombrePunto(origen)}</dd>
          <dt>Hasta</dt>
          <dd>{nombrePunto(destino)}</dd>
        </dl>
      ) : null}

      {pedido?.fase === 'incierta' ? (
        <div className="incierto">
          <p className="error">No sabemos si se pidió el viaje: no llegó la respuesta.</p>
          <MensajeError error={pedido.error} />
          <div className="acciones">
            <button type="button" onClick={() => usePasajero.getState().reintentarPedido()}>
              Reintentar
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="principal"
          disabled={!listo || pedido !== null}
          onClick={() => origen && destino && usePasajero.getState().pedirViaje(origen, destino)}
        >
          {pedido ? 'Pidiendo…' : 'Pedir viaje'}
        </button>
      )}
      {errorPedido ? <MensajeError error={errorPedido} /> : null}
    </div>
  );
}

/** Con viaje: dónde está el chofer, el recorrido, la tarifa, el cobro y las acciones. */
function DetalleViaje({ envio }: { envio: ReturnType<typeof useEnvioUbicacion> }) {
  const viaje = usePasajero((s) => s.viaje)!;
  const cancelacion = usePasajero((s) => s.cancelacion);
  const ahora = useAhora();
  const [confirmando, setConfirmando] = useState(false);
  const activo = esActivo(viaje);
  const tarifa = viaje.tarifa;
  const referencia = viaje.estado === 'EN_CURSO' ? viaje.destino : viaje.origen;

  return (
    <div className="detalle">
      <div className="encabezado envuelve">
        <h2>{!activo ? 'Resumen' : viaje.choferId ? 'Tu chofer' : 'Detalle'}</h2>
        {/* Buscando, el estado ya lo dicen la línea de tiempo y la nota de abajo. */}
        {viaje.estado !== 'BUSCANDO' ? (
          <span className={`etiqueta estado-${viaje.estado.toLowerCase()}`}>{ETIQUETA_ESTADO[viaje.estado]}</span>
        ) : null}
      </div>
      <Chofer ahora={ahora} referencia={referencia} />

      <dl className="datos-viaje">
        <dt>Desde</dt>
        <dd>{nombrePunto(viaje.origen)}</dd>
        <dt>Hasta</dt>
        <dd>{nombrePunto(viaje.destino)}</dd>
      </dl>

      {!activo && viaje.estado !== 'COMPLETADA' ? (
        // Cancelado o sin choferes: no se cobra (lo mismo que dice el historial).
        <div className="tarifa">
          <p className="nota">Importe</p>
          <p className="monto">Sin cargo</p>
        </div>
      ) : tarifa ? (
        tarifa.finalCentavos !== null ? (
          <div className="tarifa">
            <p className="nota">Tarifa final</p>
            <p className="monto">{pesos(tarifa.finalCentavos)}</p>
            <p className="nota">
              Estimada: {pesos(tarifa.estimadaCentavos)}
              {tarifa.motivosDiferencia.length > 0
                ? ` · cambió por ${tarifa.motivosDiferencia.map((m) => (m === 'DISTANCIA' ? 'la distancia' : 'la duración')).join(' y ')}`
                : ''}
            </p>
          </div>
        ) : (
          <div className="tarifa">
            <p className="nota">Estimación</p>
            <p className="monto">{pesos(tarifa.estimadaCentavos)}</p>
            <p className="nota">
              {textoDistancia(tarifa.recorridoEstimado.metros)} · {Math.max(1, Math.round(tarifa.recorridoEstimado.segundos / 60))} min
            </p>
          </div>
        )
      ) : null}

      {viaje.estado === 'COMPLETADA' ? <CobroViaje /> : null}

      {viaje.estado === 'ASIGNADO' || viaje.estado === 'EN_CAMINO' ? (
        <div className="compartir">
          <h3>Tu ubicación para el chofer</h3>
          <ControlUbicacion envio={envio} inactivo="Se comparte mientras el chofer viene a buscarte." />
        </div>
      ) : null}

      {viaje.estado === 'EN_CURSO' && !cancelacion ? (
        <p className="nota">Ya estás en viaje: desde acá no se puede cancelar.</p>
      ) : activo ? (
        cancelacion?.fase === 'incierta' ? (
          <div className="incierto">
            <p className="error">No sabemos si se canceló: no llegó la respuesta.</p>
            <MensajeError error={cancelacion.error} />
            <button type="button" onClick={() => usePasajero.getState().reintentarCancelacion()}>
              Reintentar
            </button>
          </div>
        ) : confirmando ? (
          <div className="confirmar" role="group" aria-label="Confirmar cancelación">
            <p>¿Cancelar el viaje?</p>
            <div className="acciones">
              <button
                type="button"
                className="peligro"
                disabled={cancelacion !== null}
                onClick={() => {
                  usePasajero.getState().cancelar();
                  setConfirmando(false);
                }}
              >
                Sí, cancelar
              </button>
              <button type="button" className="secundario" onClick={() => setConfirmando(false)}>
                No
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="secundario" disabled={cancelacion !== null} onClick={() => setConfirmando(true)}>
            {cancelacion ? 'Cancelando…' : 'Cancelar viaje'}
          </button>
        )
      ) : (
        <button type="button" className="principal" onClick={() => usePasajero.getState().nuevoViaje()}>
          Pedir otro viaje
        </button>
      )}
    </div>
  );
}

/** Dónde está el chofer, a qué distancia del punto que importa ahora, y hace cuánto llegó la posición. */
function Chofer({ ahora, referencia }: { ahora: number; referencia: Punto }) {
  const viaje = usePasajero((s) => s.viaje)!;
  const posicion = usePasajero((s) => s.posicionChofer);
  if (viaje.estado === 'BUSCANDO') return <p className="nota">Buscando un chofer cerca del origen…</p>;
  if (!['ASIGNADO', 'EN_CAMINO', 'EN_CURSO'].includes(viaje.estado)) return null;
  if (!posicion) return <p className="nota">Todavía sin posición del chofer: llega con su próximo envío.</p>;
  const edad = ahora - Date.parse(posicion.actualizadaEn);
  const vieja = edad > VIGENCIA_MS;
  const hasta = viaje.estado === 'EN_CURSO' ? 'del destino' : 'del origen';
  return (
    <p className={vieja ? 'error' : undefined}>
      <strong className="distancia">{textoDistancia(distanciaMetros(posicion, referencia))}</strong> {hasta} · {hace(edad)}
      {vieja ? ' · sin datos recientes' : ''}
    </p>
  );
}

function CobroViaje() {
  const cobro = usePasajero((s) => s.cobro);
  const consulta = usePasajero((s) => s.consultaCobro);
  if (cobro?.estado === 'APROBADO') return <p className="ok">Cobro aprobado: {pesos(cobro.montoCentavos)}.</p>;
  if (cobro?.estado === 'RECHAZADO') return <p className="error">El cobro fue rechazado{cobro.motivoRechazo ? `: ${cobro.motivoRechazo}` : '.'}</p>;
  return (
    <div className="cobro">
      <p className="nota">El cobro se procesa solo en unos segundos.</p>
      <button type="button" className="secundario" disabled={consulta.cargando} onClick={() => void usePasajero.getState().consultarCobro()}>
        {consulta.cargando ? 'Consultando…' : 'Ver el cobro ahora'}
      </button>
      {consulta.error ? <MensajeError error={consulta.error} /> : null}
    </div>
  );
}
