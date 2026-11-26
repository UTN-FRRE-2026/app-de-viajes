import { useEffect, useState } from 'react';
import { esIncierto } from '../../api/operacion';
import { ErrorApi } from '../../api/errores';
import { CartelDestino, type Cartel } from '../../componentes/CartelDestino';
import { CopiarCodigo } from '../../componentes/CopiarCodigo';
import { IconoDireccion, IconoFlecha } from '../../componentes/Iconos';
import { MensajeError, textoDeError } from '../../componentes/MensajeError';
import { useAhora } from '../../componentes/useAhora';
import { Mapa } from '../../mapa/Mapa';
import { useRuta } from '../../mapa/useRuta';
import type { EstadoConexion } from '../../tiempo-real/eventos';
import { useEventos } from '../../tiempo-real/useEventos';
import { useSesion } from '../../sesion/store';
import { ControlUbicacion } from '../../ubicacion/ControlUbicacion';
import { coordenadasDelToque } from '../../ubicacion/posicion';
import { useEnvioUbicacion, type EnvioUbicacion } from '../../ubicacion/useEnvioUbicacion';
import { Posicion } from '../../viaje/Posicion';
import {
  distanciaMetros,
  numeroViaje,
  pesos,
  textoDistancia,
  textoMinutos,
  type OfertaPendiente,
  type Punto,
} from '../../viaje/viaje';
import { nombrePunto } from '../pasajero/lugares';
import { avanceSimulado, ofertasVisibles, restanteMs, SIGUIENTE } from './logica';
import { useChofer } from './store';
import { useConduccionSimulada, type Conduccion } from './useConduccionSimulada';

const TEXTO_CONEXION: Record<EstadoConexion, string> = {
  conectando: 'Conectando…',
  conectado: 'En línea',
  reconectando: 'Reconectando…',
  detenido: 'Sin conexión',
};

/** Lo que dura una oferta (OFERTA_TTL_SEGUNDOS de dispatch, 15 s): la escala de la barra que se vacía. */
const VIGENCIA_OFERTA_MS = 15_000;

/**
 * La pantalla del chofer: el mapa con su auto y la ruta, y abajo la disponibilidad, las ofertas como
 * carteles que vencen y el viaje activo.  Lo que muestra sale de `GET /chofer/estado`: se
 * relee al abrir, al reconectar el stream y con cada evento. Así, al recargar, el viaje activo y las
 * ofertas pendientes vuelven solos.
 */
export function PanelChofer() {
  const cargado = useChofer((s) => s.cargado);
  const errorLectura = useChofer((s) => s.errorLectura);
  const viaje = useChofer((s) => s.viaje);
  const disponible = useChofer((s) => s.registro?.disponible ?? false);
  const aviso = useChofer((s) => s.aviso);
  const posicionPasajero = useChofer((s) => s.posicionPasajero);

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
  // Por defecto, «Simulada (demo)»: el auto maneja solo por la ruta real.
  const envio = useEnvioUbicacion('/ubicacion/ubicaciones', disponible || viaje !== null, { simulada: true });
  const simulada = envio.modo === 'simulada';
  const conduccion = useConduccionSimulada({ activa: simulada, viaje, posicion: envio.fijacion, mover: envio.fijarSimulada });

  // Los avances automáticos de la simulada: «Voy en camino» al quedar asignado y «Finalizar» al llegar
  // al destino, cuando location ya tiene ese último punto. Una vez por viaje y acción (el store lo anota).
  const finalEnviado = viaje !== null && envio.enviada !== null && conduccion.llego && distanciaMetros(envio.enviada, viaje.destino) < 1;
  const accionSola = simulada ? avanceSimulado(viaje, { llego: conduccion.llego, finalEnviado }) : null;
  const viajeId = viaje?.id;
  useEffect(() => {
    if (accionSola) useChofer.getState().avanzarSolo(accionSola);
  }, [accionSola, viajeId]);

  // «Ubicarme en el mapa» (solo en manual): el próximo toque fija la posición y cierra la selección.
  // Fuera de eso, el mapa se puede mover y tocar sin cambiar dónde está el auto.
  const [eligiendo, setEligiendo] = useState(false);
  const enMapa = eligiendo && envio.modo === 'manual';
  useEffect(() => {
    if (envio.modo !== 'manual') setEligiendo(false);
  }, [envio.modo]);
  useEffect(() => {
    if (!enMapa) return;
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEligiendo(false);
    };
    window.addEventListener('keydown', alTeclear);
    return () => window.removeEventListener('keydown', alTeclear);
  }, [enMapa]);
  const ubicarEnMapa = {
    eligiendo: enMapa,
    alternar: () => {
      // En el celular la hoja tapa el mapa: se vuelve arriba, de una, para que se vea dónde tocar.
      if (!enMapa) window.scrollTo({ top: 0 });
      setEligiendo(!enMapa);
    },
  };
  const tocarMapa = (p: Punto) => {
    const c = coordenadasDelToque(p);
    if (!c) return;
    envio.fijarManual(c);
    setEligiendo(false);
  };

  // En el mapa: el viaje activo o, si no, la primera oferta. El auto es uno mismo.
  const ahora = useAhora(1000);
  const estado = useChofer();
  const oferta = estado.aceptacion?.oferta ?? ofertasVisibles(estado, ahora)[0] ?? null;
  const trabajo = viaje ?? oferta;
  const yo = envio.fijacion;
  const enViaje = viaje?.estado === 'EN_CURSO';
  const rutaTrabajo = useRuta(trabajo ? trabajo.origen : null, trabajo ? trabajo.destino : null);
  // En la simulada, en camino o en curso, el tramo es la ruta fija que maneja el auto: no se pide otra.
  const manejando = simulada && (viaje?.estado === 'EN_CAMINO' || enViaje);
  const desdeAuto = trabajo && yo && !manejando ? yo : null;
  const rutaAuto = useRuta(desdeAuto, desdeAuto && trabajo ? (enViaje ? trabajo.destino : trabajo.origen) : null, { auto: true });
  const tramo = manejando ? tramoSimulado(conduccion) : rutaAuto;
  const llego = manejando && conduccion.llego;

  if (!cargado) {
    return errorLectura ? (
      <section className="tarjeta angosto-centrado">
        <MensajeError error={errorLectura} onReintentar={() => void useChofer.getState().releer()} />
      </section>
    ) : (
      <p className="cargando">Cargando…</p>
    );
  }

  const marcas = {
    origen: trabajo?.origen ?? null,
    destino: trabajo?.destino ?? null,
    movil: yo,
    persona: viaje && !enViaje ? posicionPasajero : null,
    ruta: enViaje && tramo ? tramo.puntos : (rutaTrabajo?.puntos ?? null),
    aproximacion: !enViaje && tramo ? tramo.puntos : null,
    mojonMetros: tramo?.distanciaMetros ?? null,
  };

  // El cartel, con viaje: a dónde ir ahora y en cuántos minutos; en la simulada, también que llegó.
  const cartel: Cartel | null = !viaje
    ? null
    : llego
      ? enViaje
        ? { tipo: 'llegada', rotulo: 'Llegaste a', lugar: nombrePunto(viaje.destino), segundos: null, detalle: 'Llegaste · finalizando el viaje' }
        : { tipo: 'llegada', rotulo: 'Llegaste a buscar al pasajero en', lugar: nombrePunto(viaje.origen), segundos: null, detalle: 'Llegaste · esperá al pasajero' }
    : enViaje
      ? { tipo: 'destino', rotulo: 'Hacia', lugar: nombrePunto(viaje.destino), segundos: tramo?.duracionSegundos ?? null, detalle: tramo ? `a ${textoDistancia(tramo.distanciaMetros)}` : null }
      : { tipo: 'encuentro', rotulo: 'Buscá al pasajero en', lugar: nombrePunto(viaje.origen), segundos: tramo?.duracionSegundos ?? null, detalle: tramo ? `a ${textoDistancia(tramo.distanciaMetros)}` : null };

  return (
    // Con una oferta o un viaje, el mapa se achica: el cartel y la acción («Aceptar», «Voy en camino»…)
    // entran en la primera pantalla del celular.
    <div className={`chofer-app ancho${viaje || oferta ? ' con-oferta' : ''}`}>
      <section className={enMapa ? 'zona-mapa eligiendo' : 'zona-mapa'} aria-label="Mapa">
        <Mapa marcas={marcas} etiqueta="Mapa del chofer" {...(enMapa ? { alTocar: tocarMapa } : {})} />
        {enMapa ? (
          <p className="nota ayuda-mapa" role="status">
            Tocá el mapa para fijar tu ubicación.
          </p>
        ) : null}
      </section>

      <section className="hoja" aria-labelledby="titulo-chofer">
        <header className="cartel">
          <div className="cartel-fila">
            <h1 id="titulo-chofer">Chofer</h1>
            <span className={`conexion ${conexion.estado}`} role="status">
              {TEXTO_CONEXION[conexion.estado]}
            </span>
          </div>
          {cartel ? <CartelDestino cartel={cartel} /> : null}
        </header>
        <div className="hoja-cuerpo">
          {conexion.error ? <p className="error">{textoDeError(conexion.error)}</p> : null}
          {aviso ? (
            <div className="aviso" role="status">
              <p>{aviso}</p>
              <button type="button" className="secundario" onClick={() => useChofer.getState().cerrarAviso()}>
                Entendido
              </button>
            </div>
          ) : null}
          {errorLectura ? <MensajeError error={errorLectura} onReintentar={() => void useChofer.getState().releer()} /> : null}

          {/* Sin estar disponible, lo primero es ponerse disponible. Disponible o con viaje, lo primero es
              el trabajo (la oferta vence en 15 s); la disponibilidad y la ubicación quedan abajo. */}
          {!disponible && !viaje ? <Disponibilidad /> : null}
          <Resumen />
          {viaje ? (
            <ViajeActivo envio={envio} llegaEnSegundos={llego ? null : (tramo?.duracionSegundos ?? null)} simulada={manejando ? { llego } : null} />
          ) : (
            <Ofertas envio={envio} hastaOrigen={oferta && tramo ? { ofertaId: oferta.ofertaId, metros: tramo.distanciaMetros } : null} />
          )}
          {disponible || viaje ? <Disponibilidad /> : null}
          <ControlUbicacion envio={envio} inactivo="Ponete disponible para compartir tu ubicación y recibir ofertas." enMapa={ubicarEnMapa} />
        </div>
      </section>
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
  const miId = useSesion((s) => s.usuario?.id);

  let motivo: string | null = null;
  if (!registro) motivo = TEXTO_DISPONIBILIDAD['CHOFER_NO_ENCONTRADO']!;
  else if (!registro.habilitado) motivo = 'Falta que la plataforma te habilite.';
  else if (!registro.activo) motivo = TEXTO_DISPONIBILIDAD['CHOFER_NO_ACTIVO']!;
  const disponible = registro?.disponible ?? false;
  const error = cambio.error;
  const textoError = error instanceof ErrorApi ? TEXTO_DISPONIBILIDAD[error.codigo] : undefined;

  return (
    <div className={disponible ? 'disponibilidad prendida' : 'disponibilidad'}>
      <div className="chapa">
        {disponible ? <strong className="ok">Disponible</strong> : <strong>No disponible</strong>}
        {registro ? (
          <span className="vehiculo-chofer">
            {registro.vehiculo.marca} {registro.vehiculo.modelo} <span className="patente">{registro.vehiculo.patente}</span>
          </span>
        ) : null}
      </div>
      {!registro && miId ? (
        // El admin de flota da de alta con este código: identity no permite buscar cuentas por email.
        <p className="nota">
          Tu código de chofer, para el alta: <CopiarCodigo codigo={miId} />
        </p>
      ) : null}
      {motivo && !disponible ? (
        <p className="nota">{motivo}</p>
      ) : (
        <button type="button" className={disponible ? 'secundario' : 'principal'} disabled={cambio.enviando} onClick={() => void cambiar(!disponible)}>
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

/** `hastaOrigen`: lo que hay por las calles hasta el origen de la oferta que muestra el mapa. */
function Ofertas({ envio, hastaOrigen }: { envio: EnvioUbicacion; hastaOrigen: { ofertaId: string; metros: number } | null }) {
  const ahora = useAhora(500);
  const estado = useChofer();
  const visibles = ofertasVisibles(estado, ahora);
  const { aceptacion, registro } = estado;

  return (
    <section className="ofertas" aria-labelledby="titulo-ofertas">
      {/* Con ofertas, el título lo leen solo los lectores de pantalla: cada oferta ya es un cartel. */}
      <h2 id="titulo-ofertas" className={aceptacion || visibles.length > 0 ? 'solo-lector' : undefined}>
        Ofertas
      </h2>
      {aceptacion ? (
        <div className="oferta resaltada">
          <CartelOferta oferta={aceptacion.oferta} restante={null} />
          <DatosOferta oferta={aceptacion.oferta} desde={envio.fijacion} metrosRuta={hastaOrigen?.ofertaId === aceptacion.oferta.ofertaId ? hastaOrigen.metros : null} />
          {aceptacion.fase === 'enviando' ? (
            <p className="nota">Aceptando…</p>
          ) : (
            <>
              <p className="error">No sabemos si se aceptó la oferta: no llegó la respuesta.</p>
              <MensajeError error={aceptacion.error} />
              <button type="button" className="principal" onClick={() => estado.reintentarAceptacion()}>
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
            <CartelOferta oferta={o} restante={restante} />
            <DatosOferta oferta={o} desde={envio.fijacion} metrosRuta={hastaOrigen?.ofertaId === o.ofertaId ? hastaOrigen.metros : null} />
            <button type="button" className="principal" disabled={vencida || aceptacion !== null} onClick={() => estado.aceptar(o)}>
              Aceptar
            </button>
          </div>
        );
      })}
      {!aceptacion && visibles.length === 0 ? (
        <p className="vacio">{registro?.disponible ? 'Esperando ofertas…' : 'No estás disponible: no vas a recibir ofertas.'}</p>
      ) : null}
    </section>
  );
}

/** DESDE → HASTA de un viaje u oferta, con los nombres de la demo cuando los hay. */
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
 * La oferta es un cartel de ruta: el pin con el origen y, a la derecha, los segundos que le quedan en
 * grande; abajo, el destino con la flecha, y la barra ámbar que se vacía como filete inferior.
 * `restante`: null mientras se está aceptando (ya no corre la cuenta).
 */
function CartelOferta({ oferta, restante }: { oferta: OfertaPendiente; restante: number | null }) {
  const vencida = restante !== null && restante <= 0;
  const segundos = restante !== null ? Math.ceil(restante / 1000) : null;
  return (
    <div className="cartel cartel-oferta">
      <CartelDestino
        cartel={{ tipo: 'encuentro', rotulo: 'Oferta de viaje: el pasajero está en', lugar: nombrePunto(oferta.origen), segundos: null }}
        cifra={segundos !== null && !vencida ? { valor: segundos, unidad: 's', antes: 'Vence en' } : null}
      />
      <p className="cartel-hacia">
        <IconoDireccion className="cartel-pictograma" />
        <span className="solo-lector">Hacia </span>
        {nombrePunto(oferta.destino)}
      </p>
      {restante !== null ? (
        <div className="oferta-vence">
          <meter
            className="vence"
            aria-label="Tiempo para aceptar"
            min={0}
            max={VIGENCIA_OFERTA_MS}
            low={4000}
            optimum={VIGENCIA_OFERTA_MS}
            value={Math.max(0, Math.min(restante, VIGENCIA_OFERTA_MS))}
          />
          {vencida ? <span className="cuenta vencio">Venció</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function DatosOferta({ oferta, desde, metrosRuta }: { oferta: OfertaPendiente; desde: Punto | null; metrosRuta: number | null }) {
  return (
    <div className="datos">
      <div className="casilleros">
        <div className="casillero">
          <span className="rotulo">Hasta el origen</span>
          <strong className="cifra">{metrosRuta !== null ? textoDistancia(metrosRuta) : desde ? textoDistancia(distanciaMetros(desde, oferta.origen)) : '—'}</strong>
        </div>
        <div className="casillero">
          <span className="rotulo">Tarifa estimada</span>
          <strong className="cifra">{oferta.tarifaEstimadaCentavos !== null ? pesos(oferta.tarifaEstimadaCentavos) : '—'}</strong>
        </div>
      </div>
    </div>
  );
}

/**
 * La ruta fija del tramo simulado, como la del auto: los puntos para dibujar y lo que falta. Los puntos
 * son siempre el mismo arreglo: el mapa no se redibuja ni reencuadra con cada paso.
 */
function tramoSimulado(c: Conduccion) {
  if (!c.ruta || c.restanteMetros === null || c.restanteSegundos === null) return null;
  return { puntos: c.ruta.puntos, distanciaMetros: c.restanteMetros, duracionSegundos: c.restanteSegundos };
}

/** `simulada`: el auto maneja solo en este tramo, y si ya llegó. Null con GPS o manual. */
function ViajeActivo({
  envio,
  llegaEnSegundos,
  simulada,
}: {
  envio: EnvioUbicacion;
  llegaEnSegundos: number | null;
  simulada: { llego: boolean } | null;
}) {
  const viaje = useChofer((s) => s.viaje);
  const operacion = useChofer((s) => s.operacion);
  const posicion = useChofer((s) => s.posicionPasajero);
  const desfaseMs = useChofer((s) => s.desfaseMs);
  if (!viaje) return null;
  const siguiente = SIGUIENTE[viaje.estado];
  const hacia = viaje.estado === 'EN_CURSO' ? 'Al destino' : 'Al origen';

  return (
    <section className="viaje-chofer" aria-labelledby="titulo-viaje-chofer">
      <div className="casilleros-cabeza">
        <h2 id="titulo-viaje-chofer">Viaje</h2>
        <span className="viaje-numero">Nº {numeroViaje(viaje.id)}</span>
      </div>
      <Trayecto desde={viaje.origen} hasta={viaje.destino} />
      <div className="casilleros">
        <div className="casillero">
          <span className="rotulo">{hacia}</span>
          <strong className="cifra">{llegaEnSegundos !== null ? textoMinutos(llegaEnSegundos) : '—'}</strong>
        </div>
        <div className="casillero">
          <span className="rotulo">Tarifa estimada</span>
          <strong className="cifra">{viaje.tarifa ? pesos(viaje.tarifa.estimadaCentavos) : '—'}</strong>
        </div>
      </div>
      <Posicion titulo="Pasajero" posicion={posicion} referencia={envio.fijacion} desfaseMs={desfaseMs} />
      {simulada && !simulada.llego ? (
        <p className="nota">
          {viaje.estado === 'EN_CURSO' ? 'El auto va solo al destino y finaliza el viaje al llegar.' : 'El auto va solo a buscar al pasajero.'}
        </p>
      ) : null}
      {siguiente ? (
        // En la simulada, mientras el auto maneja, el botón queda secundario: la acción del momento es
        // esperar. Al llegar al origen, «Inició el viaje» vuelve a ser la principal.
        <button
          type="button"
          className={simulada && !simulada.llego ? 'secundario' : 'principal'}
          disabled={operacion !== null}
          onClick={() => useChofer.getState().avanzar()}
        >
          {operacion?.fase === 'enviando' ? 'Enviando…' : siguiente.texto}
        </button>
      ) : null}
      {operacion?.fase === 'incierta' ? (
        <div className="incierto">
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
    <section className="resumen" role="status" aria-labelledby="titulo-resumen">
      <h2 id="titulo-resumen">Viaje terminado</h2>
      {final !== null ? (
        <div className="importe">
          <p className="rotulo">Tarifa final</p>
          <p className="monto">{pesos(final)}</p>
        </div>
      ) : null}
      <button type="button" className="secundario" onClick={() => useChofer.getState().cerrarResumen()}>
        Listo
      </button>
    </section>
  );
}
