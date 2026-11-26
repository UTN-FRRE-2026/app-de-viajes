import { NavLink, Outlet, useNavigate } from 'react-router';
import { cerrarSesion } from '../api/cliente';
import { moduloDe } from '../roles';
import { useSesion } from '../sesion/store';
import { ErrorBoundary } from './ErrorBoundary';
import { IconoDeRuta, IconoSalir, Marca } from './Iconos';

/**
 * El marco de las pantallas con sesión: la barra marina con la marca, el menú del rol, quién está y
 * cerrar sesión. En el celular el menú baja a una barra fija al pie, al alcance del pulgar.
 */
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
        <span className="marca">
          <Marca className="marca-logo" />
          <span className="marca-nombre">Viajes</span>
        </span>
        <nav className="menu" aria-label="Secciones">
          {modulo?.menu.map((item) => (
            <NavLink key={item.ruta} to={item.ruta} end>
              <IconoDeRuta ruta={item.ruta} className="menu-icono" />
              <span>{item.texto}</span>
            </NavLink>
          ))}
        </nav>
        <span className="quien">
          {usuario?.nombre} · {modulo?.titulo}
        </span>
        <button type="button" className="salir" onClick={() => void salir()}>
          <IconoSalir className="menu-icono" />
          <span className="salir-texto">Cerrar sesión</span>
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
