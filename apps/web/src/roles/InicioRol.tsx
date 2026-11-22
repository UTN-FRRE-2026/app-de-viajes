import { useSesion } from '../sesion/store';

/** Inicio provisorio de cada rol: las pantallas reales las suma su dueño (docs/web.md). */
export function InicioRol({ titulo, descripcion }: { titulo: string; descripcion: string }) {
  const usuario = useSesion((s) => s.usuario);
  return (
    <section className="tarjeta">
      <h1>{titulo}</h1>
      <p>
        Hola, <strong>{usuario?.nombre}</strong>.
      </p>
      <p className="nota">{descripcion}</p>
    </section>
  );
}
