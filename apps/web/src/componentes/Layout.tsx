import { NavLink, Outlet, useNavigate } from 'react-router';
import { cerrarSesion } from '../api/cliente';
import { moduloDe } from '../roles';
import { useSesion } from '../sesion/store';
import { ErrorBoundary } from './ErrorBoundary';

/** El marco de las pantallas con sesión: el menú del rol, quién está y cerrar sesión. */
export function Layout() {
  const usuario = useSesion((s) => s.usuario);
  const navegar = useNavigate();
  const modulo = usuario ? moduloDe(usuario.rol) : null;

  const salir = async () => {
    await cerrarSesion();
    navegar('/login', { replace: true });
  };

  return (
    <div className="marco">
      <header className="barra">
        <strong className="marca">Viajes</strong>
        <nav>
          {modulo?.menu.map((item) => (
            <NavLink key={item.ruta} to={item.ruta} end>
              {item.texto}
            </NavLink>
          ))}
        </nav>
        <span className="quien">
          {usuario?.nombre} · {modulo?.titulo}
        </span>
        <button type="button" onClick={() => void salir()}>
          Cerrar sesión
        </button>
      </header>
      <main className="contenido">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
