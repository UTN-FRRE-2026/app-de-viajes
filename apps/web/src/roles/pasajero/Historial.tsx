import { useCallback, useEffect, useState } from 'react';
import { pedir } from '../../api/cliente';
import { MensajeError } from '../../componentes/MensajeError';
import { ETIQUETA_ESTADO } from '../../viaje/viaje';
import { textoImporte, type ListadoViajes, type ViajeResumen } from './logica';
import { textoRecorrido } from './lugares';

const FECHA = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const POR_PAGINA = 10;

/** El historial del pasajero (`GET /historial`), los más nuevos primero, de a 10. */
export function HistorialPasajero() {
  const [viajes, setViajes] = useState<ViajeResumen[]>([]);
  const [siguiente, setSiguiente] = useState<number | null>(0);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const cargar = useCallback(async (desde: number) => {
    setCargando(true);
    setError(null);
    try {
      const r = await pedir<ListadoViajes>('GET', `/viajes/historial?limite=${POR_PAGINA}&desde=${desde}`);
      setViajes((v) => (desde === 0 ? r.viajes : [...v, ...r.viajes]));
      setSiguiente(r.siguiente);
    } catch (err) {
      setError(err);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar(0);
  }, [cargar]);

  return (
    <section className="tarjeta" aria-labelledby="titulo-historial">
      <h1 id="titulo-historial">Historial</h1>
      {viajes.length === 0 && !cargando && !error ? <p className="nota">Todavía no pediste viajes.</p> : null}
      {viajes.length > 0 ? (
        <table className="tabla">
          <thead>
            <tr>
              <th scope="col">Fecha</th>
              <th scope="col">Recorrido</th>
              <th scope="col">Estado</th>
              <th scope="col" className="numero">
                Importe
              </th>
            </tr>
          </thead>
          <tbody>
            {viajes.map((v) => (
              <tr key={v.id}>
                <td className="fecha">{FECHA.format(new Date(v.creadaEn))}</td>
                <td title={textoRecorrido(v.origen, v.destino).detalle}>{textoRecorrido(v.origen, v.destino).texto}</td>
                <td>
                  <span className={`etiqueta estado-${v.estado.toLowerCase()}`}>{ETIQUETA_ESTADO[v.estado]}</span>
                </td>
                <td className="numero">{textoImporte(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {error ? <MensajeError error={error} onReintentar={() => void cargar(viajes.length)} /> : null}
      {cargando ? <p className="nota">Cargando…</p> : null}
      {siguiente !== null && siguiente > 0 && !cargando ? (
        <button type="button" className="secundario" onClick={() => void cargar(siguiente)}>
          Ver más
        </button>
      ) : null}
    </section>
  );
}
