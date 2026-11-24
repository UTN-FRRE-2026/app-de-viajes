import { useEffect, useState, type FormEvent } from 'react';
import { ErrorApi } from '../../api/errores';
import { CopiarCodigo } from '../../componentes/CopiarCodigo';
import { enLimite, erroresAlta, motivoSinActivar, textoErrorFlota, textoLimite, textoVehiculo, type Chofer } from './logica';
import { useFlota } from './store';

/**
 * El panel del admin de flota: el cupo (activos y límite), la lista de choferes, el alta de un chofer
 * existente con su vehículo, y activar o desactivar. La flota es la del token: la pantalla nunca la
 * manda. No hay eventos de flotas: se relee al abrir, con «Actualizar» y al volver a la pestaña.
 */
export function PanelFlota() {
  const flota = useFlota((s) => s.flota);
  const listaCargada = useFlota((s) => s.listaCargada);
  const errorLectura = useFlota((s) => s.errorCupo ?? s.errorLista);

  useEffect(() => {
    const { reiniciar, refrescar } = useFlota.getState();
    reiniciar();
    void refrescar();
    const alVolver = () => {
      if (document.visibilityState === 'visible') void useFlota.getState().refrescar();
    };
    document.addEventListener('visibilitychange', alVolver);
    return () => {
      document.removeEventListener('visibilitychange', alVolver);
      useFlota.getState().reiniciar();
    };
  }, []);

  if (!flota || !listaCargada) {
    return errorLectura ? (
      <section className="tarjeta">
        <ErrorLectura error={errorLectura} />
      </section>
    ) : (
      <p className="cargando">Cargando…</p>
    );
  }

  return (
    <div className="panel">
      <Cupo />
      {errorLectura ? <ErrorLectura error={errorLectura} /> : null}
      <FormAlta />
      <Lista />
    </div>
  );
}

function ErrorLectura({ error }: { error: unknown }) {
  const flota = useFlota((s) => s.flota);
  const requestId = error instanceof ErrorApi ? error.requestId : null;
  return (
    <div className="error" role="alert">
      <p>{textoErrorFlota(error, flota)}</p>
      {requestId ? <p className="nota">Código de seguimiento: {requestId}</p> : null}
      <button type="button" onClick={() => void useFlota.getState().refrescar()}>
        Reintentar
      </button>
    </div>
  );
}

function Cupo() {
  const flota = useFlota((s) => s.flota)!;
  return (
    <section className="tarjeta">
      <div className="encabezado">
        <h1>{flota.nombre}</h1>
        <button type="button" className="secundario" onClick={() => void useFlota.getState().refrescar()}>
          Actualizar
        </button>
      </div>
      <div className="cupo">
        <p>
          Activos: <strong>{flota.activos}</strong> de <strong>{flota.maxActivos}</strong>
        </p>
        <meter min={0} max={Math.max(flota.maxActivos, 1)} value={flota.activos} aria-label="Cupo de choferes activos" />
      </div>
      {enLimite(flota) ? (
        <div className="aviso" role="status">
          <p>{textoLimite(flota)}</p>
        </div>
      ) : (
        <p className="nota">
          Quedan {flota.maxActivos - flota.activos} {flota.maxActivos - flota.activos === 1 ? 'cupo libre' : 'cupos libres'}. La habilitación de cada
          chofer la hace el admin de la plataforma; activarlo, vos.
        </p>
      )}
    </section>
  );
}

const VACIO = { choferId: '', patente: '', marca: '', modelo: '' };

function FormAlta() {
  const alta = useFlota((s) => s.alta);
  const flota = useFlota((s) => s.flota);
  const [campos, setCampos] = useState(VACIO);
  const [errores, setErrores] = useState<ReturnType<typeof erroresAlta>>({});
  const bloqueado = alta !== null && (alta.fase === 'enviando' || alta.fase === 'verificando' || alta.fase === 'incierta');

  // Con el alta confirmada, el formulario queda listo para la próxima.
  useEffect(() => {
    if (alta?.fase === 'listo') setCampos(VACIO);
  }, [alta?.fase]);

  const enviar = (ev: FormEvent) => {
    ev.preventDefault();
    const datos = { choferId: campos.choferId, vehiculo: { patente: campos.patente, marca: campos.marca, modelo: campos.modelo } };
    const e = erroresAlta(datos);
    setErrores(e);
    if (Object.keys(e).length === 0) useFlota.getState().darDeAlta(datos);
  };
  const campo = (nombre: keyof typeof VACIO, texto: string, ayuda?: string) => (
    <label>
      {texto}
      <input
        name={nombre}
        value={campos[nombre]}
        disabled={bloqueado}
        autoComplete="off"
        spellCheck={false}
        onChange={(ev) => setCampos({ ...campos, [nombre]: ev.target.value })}
        aria-invalid={errores[nombre] ? true : undefined}
      />
      {errores[nombre] ? <span className="error">{errores[nombre]}</span> : ayuda ? <span className="nota">{ayuda}</span> : null}
    </label>
  );

  return (
    <section className="tarjeta">
      <h2>Dar de alta un chofer</h2>
      <form className="formulario-alta" onSubmit={enviar} noValidate>
        {campo('choferId', 'Código del chofer', 'El chofer lo ve en su pantalla mientras no está en una flota.')}
        <div className="vehiculo">
          {campo('patente', 'Patente', 'ABC123 o AB123CD')}
          {campo('marca', 'Marca')}
          {campo('modelo', 'Modelo')}
        </div>
        <button type="submit" disabled={bloqueado}>
          {alta?.fase === 'enviando' ? 'Dando de alta…' : alta?.fase === 'verificando' ? 'Comprobando…' : 'Dar de alta'}
        </button>
      </form>

      {alta?.fase === 'listo' && alta.real ? (
        <p className="ok" role="status">
          Alta hecha: {textoVehiculo(alta.real.vehiculo)}. Queda inactivo hasta que el admin de la plataforma lo habilite y lo actives.
        </p>
      ) : null}
      {alta?.fase === 'difiere' && alta.real ? (
        <div className="aviso" role="status">
          <p>
            Ese chofer ya está en tu flota, pero con otro vehículo: {textoVehiculo(alta.real.vehiculo)}. El alta con{' '}
            {textoVehiculo(alta.datos.vehiculo)} no se aplicó.
          </p>
          <button type="button" onClick={() => useFlota.getState().cerrarAlta()}>
            Entendido
          </button>
        </div>
      ) : null}
      {alta?.fase === 'error' ? (
        <p className="error" role="alert">
          {textoErrorFlota(alta.error, flota)}
        </p>
      ) : null}
      {alta?.fase === 'incierta' ? (
        <div className="error" role="alert">
          <p>No sabemos si se dio de alta: {textoErrorFlota(alta.error, flota)}</p>
          <div className="acciones">
            <button type="button" onClick={() => useFlota.getState().reintentarAlta()}>
              Reintentar
            </button>
            <button type="button" className="secundario" onClick={() => useFlota.getState().descartarAlta()}>
              Descartar
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Lista() {
  const choferes = useFlota((s) => s.choferes);
  const siguiente = useFlota((s) => s.siguiente);
  const cargandoMas = useFlota((s) => s.cargandoMas);
  const errorMas = useFlota((s) => s.errorMas);
  const flota = useFlota((s) => s.flota);

  return (
    <section className="tarjeta">
      <h2>Choferes</h2>
      {choferes.length === 0 ? (
        <p className="nota">Todavía no hay choferes: dá de alta uno con su código.</p>
      ) : (
        <ul className="choferes">
          {choferes.map((c) => (
            <Fila key={c.id} chofer={c} />
          ))}
        </ul>
      )}
      {errorMas ? <p className="error">{textoErrorFlota(errorMas, flota)}</p> : null}
      {siguiente !== null ? (
        <button type="button" className="secundario" disabled={cargandoMas} onClick={() => void useFlota.getState().cargarMas()}>
          {cargandoMas ? 'Cargando…' : 'Ver más'}
        </button>
      ) : null}
    </section>
  );
}

const EN_CURSO = { activar: 'Activando…', desactivar: 'Desactivando…' } as const;

function Fila({ chofer: c }: { chofer: Chofer }) {
  const op = useFlota((s) => s.operaciones[c.id]);
  const flota = useFlota((s) => s.flota);
  const { cambiarActivo, reintentar, cerrarOperacion } = useFlota.getState();
  const motivo = motivoSinActivar(c);
  const ocupada = op !== undefined && op.fase !== 'error';

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
        {op?.fase === 'enviando' ? <span className="nota">{EN_CURSO[op.accion]}</span> : null}
        {op?.fase === 'verificando' ? <span className="nota">Sin respuesta: comprobando cómo quedó…</span> : null}
        {!ocupada ? (
          c.activo ? (
            <button type="button" className="secundario" onClick={() => cambiarActivo(c.id, 'desactivar')}>
              Desactivar (libera un cupo)
            </button>
          ) : (
            <button type="button" disabled={motivo !== null} onClick={() => cambiarActivo(c.id, 'activar')}>
              Activar
            </button>
          )
        ) : null}
      </div>
      {motivo && !c.activo ? <p className="nota">{motivo}</p> : null}
      {op?.fase === 'incierta' ? (
        <div className="error" role="alert">
          <p>
            No sabemos si se {op.accion === 'activar' ? 'activó' : 'desactivó'}: {textoErrorFlota(op.error, flota)}
          </p>
          <button type="button" onClick={() => reintentar(c.id)}>
            Reintentar
          </button>
        </div>
      ) : null}
      {op?.fase === 'error' ? (
        <div className="error" role="alert">
          <p>{textoErrorFlota(op.error, flota)}</p>
          <button type="button" className="secundario" onClick={() => cerrarOperacion(c.id)}>
            Entendido
          </button>
        </div>
      ) : null}
    </li>
  );
}
