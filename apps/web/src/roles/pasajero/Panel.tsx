import { useEffect, useState } from 'react';
import { CartelDestino, type Cartel } from '../../componentes/CartelDestino';
import { IconoFlecha, PictogramaPaso } from '../../componentes/Iconos';
import { MensajeError, textoDeError } from '../../componentes/MensajeError';
import { hace, useAhora } from '../../componentes/useAhora';
import { Mapa } from '../../mapa/Mapa';
import { useRuta, type Ruta } from '../../mapa/useRuta';
import type { EstadoConexion } from '../../tiempo-real/eventos';
import { useEventos } from '../../tiempo-real/useEventos';
import { ControlUbicacion } from '../../ubicacion/ControlUbicacion';
import { VIGENCIA_MS } from '../../ubicacion/posicion';
import { useEnvioUbicacion } from '../../ubicacion/useEnvioUbicacion';
import { distanciaMetros, numeroViaje, pesos, textoDistancia, textoMinutos, type Punto } from '../../viaje/viaje';
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
 * La pantalla del pasajero: el mapa con la ruta real y el auto, y abajo la hoja del viaje con su cartel.
 * Cada evento que llega por el SSE sella su casillero con la hora en que llegó. Lo que muestra sale
 * del historial (`GET /historial`): se relee al abrir, al reconectar el stream y con cada evento. Al
 * recargar, el viaje activo vuelve solo.
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

  // Las rutas del mapa: el viaje entero y, con chofer, el tramo del auto hasta el punto que importa.
  const conChofer = viaje !== null && posicionChofer !== null && ['ASIGNADO', 'EN_CAMINO', 'EN_CURSO'].includes(viaje.estado);
  const enViaje = viaje?.estado === 'EN_CURSO';
  const rutaViaje = useRuta(viaje ? viaje.origen : origen, viaje ? viaje.destino : destino);
  const tramo = useRuta(conChofer ? posicionChofer : null, conChofer && viaje ? (enViaje ? viaje.destino : viaje.origen) : null);
  const estimado = usePasajero((s) => s.estimacion?.datos ?? null);

  const fijar = (campo: Campo, p: Punto) => {
    if (campo === 'origen') {
      setOrigen(p);
      // Elegido el origen, el próximo toque en el mapa es el destino (si todavía no hay).
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
    ? {
        origen: viaje.origen,
        destino: viaje.destino,
        movil: posicionChofer,
        movilVieja,
        // En viaje, el tramo del auto al destino reemplaza a la ruta entera.
        ruta: enViaje && tramo ? tramo.puntos : (rutaViaje?.puntos ?? null),
        aproximacion: !enViaje && tramo ? tramo.puntos : null,
        mojonMetros: tramo?.distanciaMetros ?? (esActivo(viaje) ? (rutaViaje?.distanciaMetros ?? null) : null),
      }
    : { origen, destino, ruta: rutaViaje?.puntos ?? null, mojonMetros: rutaViaje?.distanciaMetros ?? null };

  // Lo que le falta al auto hasta el punto que importa: por las calles si hay ruta (lo mismo que el
  // mojón); si no, en línea recta. Va en el cartel, así se ve aunque el mojón no se dibuje.
  const distanciaChofer =
    viaje && posicionChofer
      ? `a ${textoDistancia(tramo?.distanciaMetros ?? distanciaMetros(posicionChofer, enViaje ? viaje.destino : viaje.origen))}`
      : null;

  // El cartel: hacia dónde va lo que importa ahora y en cuántos minutos.
  const cartel: Cartel | null = !viaje
    ? destino
      ? {
          tipo: 'destino',
          rotulo: 'Hacia',
          lugar: nombrePunto(destino),
          segundos: estimado?.duracionSegundos ?? null,
          detalle: estimado ? textoDistancia(estimado.distanciaMetros) : null,
        }
      : null
    : viaje.estado === 'ASIGNADO' || viaje.estado === 'EN_CAMINO'
      ? {
          tipo: 'encuentro',
          rotulo: 'Tu chofer te busca en',
          lugar: nombrePunto(viaje.origen),
          segundos: tramo?.duracionSegundos ?? null,
          detalle: distanciaChofer,
        }
      : viaje.estado === 'EN_CURSO' || viaje.estado === 'BUSCANDO'
        ? {
            tipo: 'destino',
            rotulo: 'Hacia',
            lugar: nombrePunto(viaje.destino),
            segundos: (enViaje ? tramo : rutaViaje)?.duracionSegundos ?? null,
            detalle: enViaje ? distanciaChofer : rutaViaje ? textoDistancia(rutaViaje.distanciaMetros) : null,
          }
        : viaje.estado === 'COMPLETADA'
          ? { tipo: 'llegada', rotulo: 'Llegaste a', lugar: nombrePunto(viaje.destino), segundos: null }
          : { tipo: 'destino', rotulo: 'Era hacia', lugar: nombrePunto(viaje.destino), segundos: null };

  return (
    // Con un viaje en curso, el mapa se achica: el cartel y las señales (con la hora del paso actual)
    // entran en la primera pantalla del celular.
    <div className={`pasajero ancho${viaje && esActivo(viaje) ? ' con-viaje' : ''}`}>
      <section className="zona-mapa" aria-label="Mapa">
        <Mapa
          marcas={marcas}
          etiqueta={viaje ? 'Mapa del viaje' : 'Mapa para elegir origen y destino'}
          {...(!viaje && marcando ? { alTocar: (p: Punto) => fijar(marcando, p) } : {})}
        />
        {!viaje ? (
          <p className="nota ayuda-mapa" role="status">
            {marcando ? `Tocá el mapa para marcar el ${marcando}.` : 'Elegí «Marcar en el mapa» para cambiar un punto.'}
          </p>
        ) : null}
      </section>

      <section className="hoja columna-viaje" aria-labelledby="titulo-viaje">
        <header className="cartel">
          <div className="cartel-fila">
            <h1 id="titulo-viaje">{viaje ? 'Tu viaje' : 'Pedir un viaje'}</h1>
            {viaje ? <span className="viaje-numero">Nº {numeroViaje(viaje.id)}</span> : null}
            <span className={`conexion ${conexion.estado}`} role="status">
              {TEXTO_CONEXION[conexion.estado]}
            </span>
          </div>
          {cartel ? <CartelDestino cartel={cartel} /> : null}
        </header>
        <div className="hoja-cuerpo columna-detalle">
          {conexion.error ? <p className="error">{textoDeError(conexion.error)}</p> : null}
          <Aviso />
          {errorLectura ? <MensajeError error={errorLectura} onReintentar={() => void usePasajero.getState().releer()} /> : null}
          {viaje ? (
            <DetalleViaje envio={envio} tramo={tramo} />
          ) : (
            <>
              <Recorrido origen={origen} destino={destino} marcando={marcando} setMarcando={setMarcando} fijar={fijar} />
              <Estimacion origen={origen} destino={destino} />
            </>
          )}
        </div>
      </section>
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

/** DESDE → HASTA, en grande. */
function Trayecto({ desde, hasta }: { desde: Punto; hasta: Punto }) {
  return (
    <dl className="trayecto">
      <div className="punta">
        <dt>Desde</dt>
        <dd>{nombrePunto(desde)}</dd>
      </div>
      <IconoFlecha className="trayecto-flecha" />
      <div className="punta">
        <dt>Hasta</dt>
        <dd>{nombrePunto(hasta)}</dd>
      </div>
    </dl>
  );
}

/**
 * Las señales del viaje: cada paso tiene su lugar fijo en la grilla, alineado con los demás, y se
 * enciende (con la hora) cuando llega su evento. Nada se pisa ni se mueve de lugar.
 */
function Senales() {
  const estado = usePasajero();
  const ahora = useAhora();
  const items = lineaDeTiempo(estado);
  return (
    <ol className="linea-tiempo senales" aria-label="Estado del viaje">
      {items.map((it) => (
        <Senal key={it.clave} item={it} ahora={ahora} />
      ))}
    </ol>
  );
}

function Senal({ item, ahora }: { item: ItemLinea; ahora: number }) {
  const { titulo, estado, hora, detalle } = item;
  return (
    <li className={`paso ${estado}`} aria-current={estado === 'actual' ? 'step' : undefined}>
      <span className="senal">
        <PictogramaPaso clave={item.clave} className="senal-pictograma" />
        <strong>{titulo}</strong>
      </span>
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

/** Origen y destino: lugares de la demo, «usar mi ubicación» o un toque en el mapa. */
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
      <legend>{campo === 'origen' ? 'Desde' : 'Hasta'}</legend>
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

/** Sin viaje: el talón con la estimación del recorrido elegido y el botón para pedir. */
function Estimacion({ origen, destino }: { origen: Punto | null; destino: Punto | null }) {
  const estimacion = usePasajero((s) => s.estimacion);
  const pedido = usePasajero((s) => s.pedido);
  const errorPedido = usePasajero((s) => s.errorPedido);
  const listo = origen !== null && destino !== null && estimacion?.datos != null && !estimacion.cargando;

  return (
    <div className="cierre fijo">
      <div className="importe">
        <h2 className="rotulo">Tarifa estimada</h2>
        {!origen || !destino ? (
          <p className="nota">Elegí el origen y el destino para ver cuánto sale.</p>
        ) : estimacion?.cargando ? (
          <p className="nota">Calculando…</p>
        ) : estimacion?.error ? (
          <MensajeError error={estimacion.error} onReintentar={() => void usePasajero.getState().estimar(origen, destino)} />
        ) : estimacion?.datos ? (
          <>
            <p className="monto">{pesos(estimacion.datos.tarifaCentavos)}</p>
            <p className="nota cifras">
              {textoDistancia(estimacion.datos.distanciaMetros)} · {textoMinutos(estimacion.datos.duracionSegundos)}
              {estimacion.datos.desglose.minimoAplicado ? ' · tarifa mínima' : ''} · la final sale del recorrido real
            </p>
          </>
        ) : null}
      </div>

      {pedido?.fase === 'incierta' ? (
        <div className="incierto">
          <p className="error">No sabemos si se pidió el viaje: no llegó la respuesta.</p>
          <MensajeError error={pedido.error} />
          <div className="acciones">
            <button type="button" className="principal" onClick={() => usePasajero.getState().reintentarPedido()}>
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

/** Con viaje: el trayecto, el chofer, las señales, y el cierre con la tarifa, el cobro y las acciones. */
function DetalleViaje({ envio, tramo }: { envio: ReturnType<typeof useEnvioUbicacion>; tramo: Ruta | null }) {
  const viaje = usePasajero((s) => s.viaje)!;
  const cancelacion = usePasajero((s) => s.cancelacion);
  const ahora = useAhora();
  const [confirmando, setConfirmando] = useState(false);
  const activo = esActivo(viaje);
  const tarifa = viaje.tarifa;
  const referencia = viaje.estado === 'EN_CURSO' ? viaje.destino : viaje.origen;

  return (
    <>
      {/* Primero las señales: el estado del viaje es la señal ámbar, sin una pastilla que lo repita. */}
      <Senales />

      <h2>{!activo ? 'Resumen' : viaje.choferId ? 'Tu chofer' : 'Detalle'}</h2>
      <Chofer ahora={ahora} referencia={referencia} tramo={tramo} />

      <Trayecto desde={viaje.origen} hasta={viaje.destino} />

      {viaje.estado === 'ASIGNADO' || viaje.estado === 'EN_CAMINO' ? (
        <div className="compartir">
          <h3>Tu ubicación para el chofer</h3>
          <ControlUbicacion envio={envio} inactivo="Se comparte mientras el chofer viene a buscarte." />
        </div>
      ) : null}

      <div className="cierre">
        {!activo && viaje.estado !== 'COMPLETADA' ? (
          // Cancelado o sin choferes: no se cobra (lo mismo que dice el historial).
          <div className="importe">
            <p className="rotulo">Importe</p>
            <p className="monto">Sin cargo</p>
          </div>
        ) : tarifa ? (
          tarifa.finalCentavos !== null ? (
            <div className="importe">
              <p className="rotulo">Tarifa final</p>
              <p className="monto">{pesos(tarifa.finalCentavos)}</p>
              <p className="nota">
                Estimada: {pesos(tarifa.estimadaCentavos)}
                {tarifa.motivosDiferencia.length > 0
                  ? ` · cambió por ${tarifa.motivosDiferencia.map((m) => (m === 'DISTANCIA' ? 'la distancia' : 'la duración')).join(' y ')}`
                  : ''}
              </p>
            </div>
          ) : (
            <div className="importe">
              <p className="rotulo">Tarifa estimada</p>
              <p className="monto">{pesos(tarifa.estimadaCentavos)}</p>
              <p className="nota cifras">
                {textoDistancia(tarifa.recorridoEstimado.metros)} · {textoMinutos(tarifa.recorridoEstimado.segundos)}
              </p>
            </div>
          )
        ) : null}

        {viaje.estado === 'COMPLETADA' ? <CobroViaje /> : null}

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
              <p>¿Cancelar el viaje? El viaje queda anulado.</p>
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
    </>
  );
}

/**
 * Los casilleros del chofer: a qué distancia está del punto que importa ahora, cuánto tarda en llegar
 * por las calles (si hay ruta) y hace cuánto llegó la posición.
 */
function Chofer({ ahora, referencia, tramo }: { ahora: number; referencia: Punto; tramo: Ruta | null }) {
  const viaje = usePasajero((s) => s.viaje)!;
  const posicion = usePasajero((s) => s.posicionChofer);
  if (viaje.estado === 'BUSCANDO') return <p className="nota">Buscando un chofer cerca del origen…</p>;
  if (!['ASIGNADO', 'EN_CAMINO', 'EN_CURSO'].includes(viaje.estado)) return null;
  if (!posicion) return <p className="nota">Todavía sin posición del chofer: llega con su próximo envío.</p>;
  const edad = ahora - Date.parse(posicion.actualizadaEn);
  const vieja = edad > VIGENCIA_MS;
  const hasta = viaje.estado === 'EN_CURSO' ? 'Al destino' : 'Del origen';
  return (
    <div className={vieja ? 'casilleros viejo' : 'casilleros'}>
      <div className="casillero">
        <span className="rotulo">{hasta}</span>
        {/* Por las calles si hay ruta (la misma que el mojón del mapa); si no, en línea recta. */}
        <strong className="distancia">{textoDistancia(tramo?.distanciaMetros ?? distanciaMetros(posicion, referencia))}</strong>
      </div>
      <div className="casillero">
        <span className="rotulo">{viaje.estado === 'EN_CURSO' ? 'Llegás en' : 'Llega en'}</span>
        <strong className="cifra">{tramo ? textoMinutos(tramo.duracionSegundos) : '—'}</strong>
      </div>
      <div className="casillero">
        <span className="rotulo">Posición</span>
        <strong className="cifra">{hace(edad)}</strong>
      </div>
      {vieja ? <p className="error casilleros-aviso">Sin datos recientes del chofer.</p> : null}
    </div>
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
