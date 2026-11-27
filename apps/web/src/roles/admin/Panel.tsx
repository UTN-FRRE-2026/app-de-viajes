import { useEffect, useState, type FormEvent } from 'react';
import { CopiarCodigo } from '../../componentes/CopiarCodigo';
import { textoVehiculo } from '../flota/logica';
import { errorCodigo, textoErrorHabilitacion, textoHecho, type Accion, type Chofer } from './logica';
import { ocupada, useHabilitacion } from './store';

const EN_CURSO: Record<Accion, string> = { habilitar: 'Habilitando…', deshabilitar: 'Deshabilitando…' };
const HECHO: Record<Accion, string> = { habilitar: 'habilitó', deshabilitar: 'deshabilitó' };

/**
 * La habilitación de choferes del admin de la plataforma (`/operador/choferes`, solo `admin`). El
 * admin de flota da de alta al chofer con su vehículo; habilitarlo es de la plataforma; activarlo,
 * otra vez de la flota. La API no lista choferes para el admin: se pega el código del chofer, y los
 * que se tocan quedan en la lista de abajo mientras dura la pantalla.
 */
export function PanelHabilitacion() {
  const recientes = useHabilitacion((s) => s.recientes);

  useEffect(() => {
    useHabilitacion.getState().reiniciar();
    return () => useHabilitacion.getState().reiniciar();
  }, []);

  return (
    <div className="panel">
      <FormHabilitacion />
      {recientes.length > 0 ? (
        <section className="tarjeta">
          <h2>Choferes de esta sesión</h2>
          <ul className="choferes">
            {recientes.map((c) => (
              <Fila key={c.id} chofer={c} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function FormHabilitacion() {
  const op = useHabilitacion((s) => s.operacion);
  const [codigo, setCodigo] = useState('');
  const [invalido, setInvalido] = useState<string | null>(null);
  const bloqueado = ocupada(op);

  // Con la habilitación confirmada, el campo queda listo para el próximo.
  useEffect(() => {
    if (op?.fase === 'listo') setCodigo('');
  }, [op?.fase]);

  const enviar = (accion: Accion) => {
    const e = errorCodigo(codigo);
    setInvalido(e);
    if (!e) useHabilitacion.getState().enviar(codigo, accion);
  };
  const alEnviar = (ev: FormEvent) => {
    ev.preventDefault();
    enviar('habilitar');
  };

  return (
    <section className="tarjeta">
      <h1>Habilitar choferes</h1>
      <p className="nota">
        El admin de cada flota da de alta a sus choferes; habilitarlos es tuyo. Recién entonces su flota los puede activar.
      </p>
      <form className="formulario-alta" onSubmit={alEnviar} noValidate>
        <label>
          Código del chofer
          <input
            name="choferId"
            value={codigo}
            disabled={bloqueado}
            autoComplete="off"
            spellCheck={false}
            onChange={(ev) => setCodigo(ev.target.value)}
            aria-invalid={invalido ? true : undefined}
          />
          {invalido ? (
            <span className="error">{invalido}</span>
          ) : (
            <span className="nota">El mismo con el que su flota lo dio de alta (el chofer lo ve en su pantalla).</span>
          )}
        </label>
        <div className="acciones">
          <button type="submit" disabled={bloqueado}>
            {op?.fase === 'enviando' && op.accion === 'habilitar' ? EN_CURSO.habilitar : 'Habilitar'}
          </button>
          <button type="button" className="secundario" disabled={bloqueado} onClick={() => enviar('deshabilitar')}>
            {op?.fase === 'enviando' && op.accion === 'deshabilitar' ? EN_CURSO.deshabilitar : 'Deshabilitar'}
          </button>
        </div>
      </form>
      <Resultado />
    </section>
  );
}

function Resultado() {
  const op = useHabilitacion((s) => s.operacion);
  if (!op) return null;
  if (op.fase === 'listo' && op.resultado) {
    return (
      <p className="ok" role="status">
        {textoHecho(op.accion, op.resultado)}
      </p>
    );
  }
  if (op.fase === 'error') {
    return (
      <p className="error" role="alert">
        {textoErrorHabilitacion(op.error)}
      </p>
    );
  }
  if (op.fase === 'incierta') {
    return (
      <div className="error" role="alert">
        <p>
          No sabemos si se {HECHO[op.accion]}: {textoErrorHabilitacion(op.error)}
        </p>
        <div className="acciones">
          <button type="button" onClick={() => useHabilitacion.getState().reintentar()}>
            Reintentar
          </button>
          <button type="button" className="secundario" onClick={() => useHabilitacion.getState().descartar()}>
            Descartar
          </button>
        </div>
      </div>
    );
  }
  return null;
}

function Fila({ chofer: c }: { chofer: Chofer }) {
  const op = useHabilitacion((s) => s.operacion);
  const bloqueado = ocupada(op);
  const accion: Accion = c.habilitado ? 'deshabilitar' : 'habilitar';
  const enCurso = op?.fase === 'enviando' && op.choferId === c.id;

  return (
    <li className="chofer">
      <div className="datos-chofer">
        <strong>{textoVehiculo(c.vehiculo)}</strong>
        <CopiarCodigo codigo={c.id} abreviado />
      </div>
      <div className="marcas">
        <span className={`etiqueta ${c.habilitado ? 'si' : 'alerta'}`}>{c.habilitado ? 'Habilitado' : 'Sin habilitar'}</span>
        <span className={`etiqueta ${c.activo ? 'si' : ''}`}>{c.activo ? 'Activo' : 'Inactivo'}</span>
        <span className={`etiqueta ${c.disponible ? 'si' : ''}`}>{c.disponible ? 'Disponible' : 'No disponible'}</span>
      </div>
      <div className="acciones">
        {enCurso ? (
          <span className="nota">{EN_CURSO[op.accion]}</span>
        ) : (
          <button
            type="button"
            className={accion === 'deshabilitar' ? 'secundario' : undefined}
            disabled={bloqueado}
            onClick={() => useHabilitacion.getState().enviar(c.id, accion)}
          >
            {accion === 'habilitar' ? 'Habilitar' : 'Deshabilitar'}
          </button>
        )}
      </div>
    </li>
  );
}
