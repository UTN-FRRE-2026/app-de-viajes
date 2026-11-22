import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { ErrorApi } from '../api/errores';
import { MensajeError } from '../componentes/MensajeError';
import { moduloDe } from '../roles';
import { entrar } from '../sesion/login';
import { useSesion } from '../sesion/store';

/** Solo rutas internas: `?volver=//otro.sitio` o una URL completa no se siguen. */
function rutaDeVuelta(valor: string | null): string | null {
  return valor && valor.startsWith('/') && !valor.startsWith('//') ? valor : null;
}

/** El login muestra su propio error: con 401, credenciales incorrectas (no una sesión vencida). */
function textoDelLogin(error: unknown): string | null {
  if (!(error instanceof ErrorApi)) return null;
  if (error.codigo === 'CREDENCIALES_INVALIDAS') return 'Email o contraseña incorrectos.';
  if (error.estado === 429) {
    const minutos = error.reintentarEnSegundos ? Math.ceil(error.reintentarEnSegundos / 60) : null;
    return `Demasiados intentos. Probá de nuevo${minutos ? ` en ${minutos} min` : ' más tarde'}.`;
  }
  if (error.estado === 400) return 'Revisá el email y la contraseña.';
  return null;
}

export function Login() {
  const estado = useSesion((s) => s.estado);
  const rol = useSesion((s) => s.usuario?.rol);
  const [parametros] = useSearchParams();
  const navegar = useNavigate();
  const [email, setEmail] = useState('');
  const [contrasena, setContrasena] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const volver = rutaDeVuelta(parametros.get('volver'));

  if (estado === 'cargando') return <p className="cargando">Cargando la sesión…</p>;
  if (estado === 'activa' && rol) return <Navigate to={volver ?? moduloDe(rol).base} replace />;

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    try {
      const usuario = await entrar(email, contrasena);
      navegar(volver ?? moduloDe(usuario.rol).base, { replace: true });
    } catch (err) {
      setError(err);
      setEnviando(false);
    }
  };

  const propio = textoDelLogin(error);
  return (
    <main className="contenido angosto">
      <form className="tarjeta" onSubmit={(e) => void enviar(e)} noValidate>
        <h1>Entrar</h1>
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Contraseña
          <input
            type="password"
            autoComplete="current-password"
            value={contrasena}
            onChange={(e) => setContrasena(e.target.value)}
            required
          />
        </label>
        {propio ? (
          <p className="error" role="alert">
            {propio}
          </p>
        ) : error ? (
          <MensajeError error={error} />
        ) : null}
        <button type="submit" disabled={enviando || !email || !contrasena}>
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}
