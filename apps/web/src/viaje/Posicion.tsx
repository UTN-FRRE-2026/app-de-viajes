import { hace, useAhora } from '../componentes/useAhora';
import { VIGENCIA_MS } from '../ubicacion/posicion';
import { distanciaMetros, textoDistancia, textoPunto, type Punto } from './viaje';

export interface PosicionEnVivo extends Punto {
  /** ISO, del servidor de location. */
  actualizadaEn: string;
}

/**
 * La posición en vivo de la otra parte del viaje (la del pasajero para el chofer, y al revés), con la
 * distancia a `referencia` si se conoce. Pasados 30 s sin novedades, avisa que no hay datos recientes.
 * `desfaseMs` (hora del servidor menos la del navegador) corrige la edad si el reloj local está corrido.
 */
export function Posicion({
  titulo,
  posicion,
  referencia,
  desfaseMs = 0,
}: {
  titulo: string;
  posicion: PosicionEnVivo | null;
  referencia?: Punto | null;
  desfaseMs?: number;
}) {
  const ahora = useAhora();
  if (!posicion) {
    return (
      <p className="nota">
        {titulo}: todavía sin posición. Llega con su próximo envío.
      </p>
    );
  }
  const edad = ahora + desfaseMs - Date.parse(posicion.actualizadaEn);
  return (
    <p className={edad > VIGENCIA_MS ? 'error' : undefined}>
      <strong>{titulo}:</strong> {textoPunto(posicion)}
      {referencia ? ` · a ${textoDistancia(distanciaMetros(referencia, posicion))}` : ''} · {hace(edad)}
      {edad > VIGENCIA_MS ? ' · sin datos recientes' : ''}
    </p>
  );
}
