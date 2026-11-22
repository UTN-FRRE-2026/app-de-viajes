import { Link } from 'react-router';
import { moduloDe } from '../roles';
import { useSesion } from '../sesion/store';

/** Una sección de otro rol, abierta por la URL. La API igual rechazaría sus pedidos (403). */
export function NoPermitido() {
  const rol = useSesion((s) => s.usuario?.rol);
  return (
    <section className="tarjeta" role="alert">
      <h1>Esta pantalla no es para tu rol</h1>
      {rol ? <Link to={moduloDe(rol).base}>Ir a tu inicio</Link> : null}
    </section>
  );
}
