// Los íconos de la app, dibujados a mano en SVG: un solo trazo (1,75) y esquinas redondeadas, en
// currentColor. Nada de emoji ni glifos. Son decorativos: el texto de al lado dice lo que hacen.

interface Props {
  className?: string;
}

const base = (className?: string) => ({
  viewBox: '0 0 24 24',
  width: 24,
  height: 24,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
  ...(className ? { className } : {}),
});

/** Un poste con su cartel de dirección: el viaje. */
export function IconoViaje({ className }: Props) {
  return (
    <svg {...base(className)}>
      <path d="M12 3.5v17M8.5 20.5h7" />
      <path d="M5.5 6h10.25L18.5 8.5 15.75 11H5.5Z" />
    </svg>
  );
}

/** Un reloj con la flecha de volver: el historial. */
export function IconoHistorial({ className }: Props) {
  return (
    <svg {...base(className)}>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.5 4.5v3.2h3.2" />
      <path d="M12 8v4.25l2.75 1.75" />
    </svg>
  );
}

/** Un volante: los viajes del chofer. */
export function IconoVolante({ className }: Props) {
  return (
    <svg {...base(className)}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.25" />
      <path d="M4.3 10.5c2.6-.9 5-.9 7.7-.9s5.1 0 7.7.9M12 14.25v5.6" />
    </svg>
  );
}

/** Un tablero de filas: el panel del operador. */
export function IconoTablero({ className }: Props) {
  return (
    <svg {...base(className)}>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M4 9.5h16M9 9.5V19" />
    </svg>
  );
}

/** Dos autos: la flota. */
export function IconoFlota({ className }: Props) {
  return (
    <svg {...base(className)}>
      <path d="M3.5 16.5v-3l1.6-3.6a1.5 1.5 0 0 1 1.4-.9h6a1.5 1.5 0 0 1 1.4.9l1.6 3.6v3Z" />
      <path d="M5.5 16.5v1.75M13.5 16.5v1.75M3.5 13.5h12" />
      <path d="M9 6.5h7.5a1.5 1.5 0 0 1 1.4.9l1.6 3.6v3h-1.5" />
    </svg>
  );
}

/** Una puerta con la flecha hacia afuera: cerrar sesión. */
export function IconoSalir({ className }: Props) {
  return (
    <svg {...base(className)}>
      <path d="M10 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H10" />
      <path d="M14 8.5 17.5 12 14 15.5M17.5 12H9.5" />
    </svg>
  );
}

/** La flecha del trayecto (de A a B). */
export function IconoFlecha({ className }: Props) {
  return (
    <svg {...base(className)}>
      <path d="M4 12h15M14.5 7.5 19 12l-4.5 4.5" />
    </svg>
  );
}

/** Un punto de encuentro (pin): dónde te buscan o dónde buscar al pasajero. */
export function IconoPin({ className }: Props) {
  return (
    <svg {...base(className)}>
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
      <circle cx="12" cy="10" r="2.4" />
    </svg>
  );
}

/** La flecha de salida de los carteles de ruta: hacia dónde se va. */
export function IconoDireccion({ className }: Props) {
  return (
    <svg {...base(className)}>
      <path d="M6.5 19v-7.5a2.5 2.5 0 0 1 2.5-2.5h9.5M14.5 5l4 4-4 4" />
    </svg>
  );
}

/** Una bandera a cuadros: se llegó. */
export function IconoLlegada({ className }: Props) {
  return (
    <svg {...base(className)}>
      <path d="M5.5 21V4M5.5 4.5h12l-2.5 4 2.5 4h-12" />
    </svg>
  );
}

/** Un reloj de arena: la oferta vence. */
export function IconoVence({ className }: Props) {
  return (
    <svg {...base(className)}>
      <path d="M7 3.5h10M7 20.5h10M8 3.5c0 4.5 4 5.5 4 8.5s-4 4-4 8.5M16 3.5c0 4.5-4 5.5-4 8.5s4 4 4 8.5" />
    </svg>
  );
}

// Los pictogramas de las señales del viaje, uno por paso (y la de anulado).
const PICTOGRAMAS: Record<string, string> = {
  // Una mano levantada: se pidió.
  pedido: 'M9 11V5.5a1.5 1.5 0 0 1 3 0V11M12 10V4.5a1.5 1.5 0 0 1 3 0V11M15 10.5V6a1.5 1.5 0 0 1 3 0v7.5a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.9-2.6L4.3 13.6a1.5 1.5 0 0 1 2.4-1.8L9 14.5V8a1.5 1.5 0 0 1 3 0',
  // El frente de un auto: hay chofer.
  asignado: 'M4.5 16.5v-4l1.8-4.4a1.6 1.6 0 0 1 1.5-1h8.4a1.6 1.6 0 0 1 1.5 1l1.8 4.4v4ZM6.5 16.5v2M17.5 16.5v2M4.5 12.5h15M7.5 14.5h1M15.5 14.5h1',
  // La flecha que dobla: viene a buscarte.
  'en-camino': 'M6.5 19v-7.5a2.5 2.5 0 0 1 2.5-2.5h9.5M14.5 5l4 4-4 4',
  // La ruta con su línea de carril: en viaje.
  'en-viaje': 'M8 20 10 4M16 20 14 4M12 6.5v2.5M12 12v2.5M12 17.5V20',
  // La bandera: se llegó.
  terminado: 'M5.5 21V4M5.5 4.5h12l-2.5 4 2.5 4h-12',
  // Un billete: se cobró.
  cobrado: 'M3.5 7h17v10h-17ZM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM6.5 10v4M17.5 10v4',
  // La cruz: anulado.
  final: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM8.5 8.5l7 7M15.5 8.5l-7 7',
};

/** El pictograma de una señal del viaje, por la clave del paso. */
export function PictogramaPaso({ clave, className }: { clave: string } & Props) {
  const d = PICTOGRAMAS[clave];
  if (!d) return null;
  return (
    <svg {...base(className)}>
      <path d={d} />
    </svg>
  );
}

/** El ícono de cada entrada del menú, por su ruta. */
export function IconoDeRuta({ ruta, className }: { ruta: string } & Props) {
  if (ruta.endsWith('/historial')) return <IconoHistorial {...(className ? { className } : {})} />;
  if (ruta.startsWith('/chofer')) return <IconoVolante {...(className ? { className } : {})} />;
  if (ruta.startsWith('/operador')) return <IconoTablero {...(className ? { className } : {})} />;
  if (ruta.startsWith('/flota')) return <IconoFlota {...(className ? { className } : {})} />;
  return <IconoViaje {...(className ? { className } : {})} />;
}

/** La marca: un cartel de ruta con su filete blanco, la flecha de salida y la línea de carril ámbar. */
export function Marca({ className }: Props) {
  return (
    <svg viewBox="0 0 40 28" width="40" height="28" aria-hidden="true" focusable="false" {...(className ? { className } : {})}>
      <rect className="marca-cartel" x="1.5" y="1.5" width="37" height="25" rx="4" />
      <rect className="marca-filete" x="4" y="4" width="32" height="20" rx="2.5" />
      <path className="marca-flecha" d="M11 19V12.5a2 2 0 0 1 2-2h11M20.5 7l4 3.5-4 3.5" />
      <path className="marca-carril" d="M29 19.5h4" />
    </svg>
  );
}

/**
 * El auto, visto desde arriba y apuntando al norte (el mapa lo gira hacia donde maneja): carrocería,
 * parabrisas, techo, luneta, espejos, ruedas y luces. Va como HTML de un `divIcon` de Leaflet, por eso
 * es un texto: sin estilos en línea, todo color sale de las clases de `estilos.css`.
 */
export const SVG_AUTO = `<svg class="mapa-auto-svg" viewBox="0 0 40 40" width="40" height="40" aria-hidden="true" focusable="false">
<rect class="auto-sombra" x="12.4" y="4.6" width="17" height="33" rx="7.5"/>
<rect class="auto-rueda" x="9" y="8.5" width="4" height="7.5" rx="1.6"/>
<rect class="auto-rueda" x="27" y="8.5" width="4" height="7.5" rx="1.6"/>
<rect class="auto-rueda" x="9" y="25" width="4" height="7.5" rx="1.6"/>
<rect class="auto-rueda" x="27" y="25" width="4" height="7.5" rx="1.6"/>
<rect class="auto-carroceria" x="11" y="3" width="18" height="34" rx="7.5"/>
<ellipse class="auto-carroceria" cx="10.2" cy="15.2" rx="1.6" ry="1.1"/>
<ellipse class="auto-carroceria" cx="29.8" cy="15.2" rx="1.6" ry="1.1"/>
<path class="auto-vidrio" d="M13.4 13.6Q20 10.6 26.6 13.6L25.4 18.2Q20 16.9 14.6 18.2Z"/>
<rect class="auto-techo" x="14.6" y="18.6" width="10.8" height="8" rx="2"/>
<path class="auto-vidrio" d="M14.6 27.4Q20 28.8 25.4 27.4L26 31.2Q20 32.8 14 31.2Z"/>
<rect class="auto-luz" x="13" y="3.9" width="4.2" height="2" rx="1"/>
<rect class="auto-luz" x="22.8" y="3.9" width="4.2" height="2" rx="1"/>
<rect class="auto-luz-trasera" x="13" y="34.3" width="4" height="1.7" rx=".8"/>
<rect class="auto-luz-trasera" x="23" y="34.3" width="4" height="1.7" rx=".8"/>
</svg>`;
