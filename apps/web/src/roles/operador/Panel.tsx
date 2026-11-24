import type { EstadoSolicitud } from '@viajes/contracts';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { pedir } from '../../api/cliente';
import { esIncierto, useClavesDeOperacion } from '../../api/operacion';
import { MensajeError } from '../../componentes/MensajeError';
import { hace, useAhora } from '../../componentes/useAhora';
import { ETIQUETA_ESTADO, type Solicitud } from '../../viaje/viaje';
import { esActivo, textoImporte, type ListadoViajes, type ViajeResumen } from '../pasajero/logica';
import { textoRecorrido } from '../pasajero/lugares';
import { FILTRO_INICIAL, idCorto, motivoValido, rutaPanel, textoRechazoCancelacion, type FiltroPanel } from './logica';

const FECHA = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Sin SSE para el operador: los activos se vuelven a pedir cada tanto. */
const REFRESCO_MS = 10_000;

/**
 * El panel del operador (y del admin): los viajes activos o los de un estado, con búsqueda, y la
 * cancelación con motivo (obligatorio para el operador), en la misma fila.
 */
export function PanelOperador() {
  const [filtro, setFiltro] = useState<FiltroPanel>(FILTRO_INICIAL);
  const [texto, setTexto] = useState('');
  const [viajes, setViajes] = useState<ViajeResumen[]>([]);
  const [siguiente, setSiguiente] = useState<number | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [actualizadoEn, setActualizadoEn] = useState<number | null>(null);
  const [cancelando, setCancelando] = useState<string | null>(null);
  const ahora = useAhora();
  // Una consulta que vuelve después de que cambió el filtro se descarta.
  const consulta = useRef(0);

  const cargar = useCallback(async (f: FiltroPanel, desde = 0) => {
    const n = ++consulta.current;
    setCargando(true);
    try {
      const r = await pedir<ListadoViajes>('GET', rutaPanel(f, desde));
      if (n !== consulta.current) return;
      setViajes((v) => (desde === 0 ? r.viajes : [...v, ...r.viajes]));
      setSiguiente(r.siguiente);
      setError(null);
      setActualizadoEn(Date.now());
    } catch (err) {
      if (n === consulta.current) setError(err);
    } finally {
      if (n === consulta.current) setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar(filtro);
  }, [filtro, cargar]);

  // Los activos se refrescan solos, salvo mientras se escribe un motivo (la fila no se mueve).
  useEffect(() => {
    if (filtro.estado !== null || cancelando) return;
    const t = setInterval(() => void cargar(filtro), REFRESCO_MS);
    return () => clearInterval(t);
  }, [filtro, cancelando, cargar]);

  const buscar = (e: FormEvent) => {
    e.preventDefault();
    setFiltro((f) => ({ ...f, texto }));
  };

  const alCancelar = (s: Solicitud) => {
    setCancelando(null);
    setViajes((v) => (filtro.estado === null ? v.filter((x) => x.id !== s.id) : v.map((x) => (x.id === s.id ? { ...x, ...s } : x))));
    void cargar(filtro);
  };

  return (
    <section className="tarjeta operador ancho" aria-labelledby="titulo-operador">
      <div className="encabezado">
        <h1 id="titulo-operador">Viajes</h1>
        <p className="nota" role="status">
          {actualizadoEn ? `Actualizado ${hace(ahora - actualizadoEn)}` : 'Cargando…'}
          {filtro.estado === null ? ' · se actualiza solo cada 10 s' : ''}
        </p>
      </div>

      <form className="filtros" onSubmit={buscar} role="search">
        <label>
          Estado
          <select value={filtro.estado ?? ''} onChange={(e) => setFiltro((f) => ({ ...f, estado: (e.target.value || null) as FiltroPanel['estado'] }))}>
            <option value="">Activos (buscando o en viaje)</option>
            {(Object.keys(ETIQUETA_ESTADO) as EstadoSolicitud[]).map((s) => (
              <option key={s} value={s}>
                {ETIQUETA_ESTADO[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="buscar">
          Buscar
          <input
            type="search"
            value={texto}
            maxLength={100}
            placeholder="Id del viaje, del pasajero o del chofer, o un motivo"
            onChange={(e) => setTexto(e.target.value)}
          />
        </label>
        <button type="submit">Buscar</button>
        <button type="button" className="secundario" disabled={cargando} onClick={() => void cargar(filtro)}>
          Actualizar
        </button>
      </form>

      {error ? <MensajeError error={error} onReintentar={() => void cargar(filtro)} /> : null}

      {viajes.length === 0 && !cargando && !error ? (
        <p className="vacio">
          {filtro.texto ? 'Ningún viaje coincide con la búsqueda.' : filtro.estado ? 'No hay viajes en ese estado.' : 'No hay viajes activos ahora.'}
        </p>
      ) : null}

      {viajes.length > 0 ? (
        <table className="tabla">
          <thead>
            <tr>
              <th scope="col">Viaje</th>
              <th scope="col">Pedido</th>
              <th scope="col">Estado</th>
              <th scope="col">Pasajero</th>
              <th scope="col">Chofer</th>
              <th scope="col">Recorrido</th>
              <th scope="col" className="numero">
                Importe
              </th>
              <th scope="col">
                <span className="solo-lector">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {viajes.map((v) => (
              <FilaViaje
                key={v.id}
                viaje={v}
                abierta={cancelando === v.id}
                abrir={() => setCancelando(v.id)}
                cerrar={() => setCancelando(null)}
                alCancelar={alCancelar}
              />
            ))}
          </tbody>
        </table>
      ) : null}

      {siguiente !== null && !cargando ? (
        <button type="button" className="secundario" onClick={() => void cargar(filtro, siguiente)}>
          Ver más
        </button>
      ) : null}
    </section>
  );
}

function FilaViaje({
  viaje: v,
  abierta,
  abrir,
  cerrar,
  alCancelar,
}: {
  viaje: ViajeResumen;
  abierta: boolean;
  abrir: () => void;
  cerrar: () => void;
  alCancelar: (s: Solicitud) => void;
}) {
  const recorrido = textoRecorrido(v.origen, v.destino);
  return (
    <>
      <tr className={abierta ? 'abierta' : undefined}>
        <td>
          <code title={v.id}>{idCorto(v.id)}</code>
        </td>
        <td className="fecha">{FECHA.format(new Date(v.creadaEn))}</td>
        <td>
          <span className={`etiqueta estado-${v.estado.toLowerCase()}`}>{ETIQUETA_ESTADO[v.estado]}</span>
          {v.motivoCancelacion ? <span className="nota motivo">{v.motivoCancelacion}</span> : null}
        </td>
        <td>
          <code title={v.pasajeroId}>{idCorto(v.pasajeroId)}</code>
        </td>
        <td>{v.choferId ? <code title={v.choferId}>{idCorto(v.choferId)}</code> : <span className="nota">—</span>}</td>
        <td title={recorrido.detalle}>{recorrido.texto}</td>
        <td className="numero">{textoImporte(v)}</td>
        <td className="accion">
          {/* El botón queda también con la fila abierta: así la columna no cambia de ancho. */}
          {esActivo(v) ? (
            <button type="button" className="secundario" aria-expanded={abierta} onClick={abierta ? cerrar : abrir}>
              Cancelar
            </button>
          ) : null}
        </td>
      </tr>
      {abierta ? (
        <tr className="fila-cancelar">
          <td colSpan={8}>
            <Cancelacion viaje={v} cerrar={cerrar} alCancelar={alCancelar} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** La cancelación con motivo. Un resultado incierto se reintenta con la MISMA Idempotency-Key. */
function Cancelacion({ viaje, cerrar, alCancelar }: { viaje: ViajeResumen; cerrar: () => void; alCancelar: (s: Solicitud) => void }) {
  const claves = useClavesDeOperacion();
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valido = motivoValido(motivo);

  const enviar = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!valido || enviando) return;
    const m = motivo.trim();
    setEnviando(true);
    setError(null);
    try {
      const s = await claves.ejecutar(`cancelar:${viaje.id}:${m}`, (clave) =>
        pedir<Solicitud>('POST', `/viajes/solicitudes/${viaje.id}/cancelar`, { cuerpo: { motivo: m }, clave }),
      );
      alCancelar(s);
    } catch (err) {
      setError(err);
    } finally {
      setEnviando(false);
    }
  };

  const rechazo = textoRechazoCancelacion(error);
  return (
    <form className="cancelar-viaje" onSubmit={(e) => void enviar(e)}>
      <label>
        Motivo de la cancelación
        <input
          value={motivo}
          minLength={3}
          maxLength={200}
          required
          autoFocus
          placeholder="Por ejemplo: el pasajero pidió cancelar por teléfono"
          onChange={(e) => setMotivo(e.target.value)}
        />
      </label>
      <div className="acciones">
        <button type="submit" className="peligro" disabled={!valido || enviando}>
          {enviando ? 'Cancelando…' : 'Cancelar viaje'}
        </button>
        <button type="button" className="secundario" onClick={cerrar} disabled={enviando}>
          Volver
        </button>
      </div>
      {error ? (
        rechazo ? (
          <p className="error">{rechazo}</p>
        ) : (
          <>
            {esIncierto(error) ? <p className="error">No sabemos si se canceló: no llegó la respuesta. Reintentá con el mismo motivo.</p> : null}
            <MensajeError error={error} onReintentar={() => void enviar()} />
          </>
        )
      ) : null}
    </form>
  );
}
