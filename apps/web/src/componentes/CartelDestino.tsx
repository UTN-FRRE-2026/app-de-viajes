import { IconoDireccion, IconoLlegada, IconoPin, IconoVence } from './Iconos';

export interface Cartel {
  /** Qué dice el pictograma: la flecha (hacia), el pin (dónde encontrarse), la bandera (llegó), el reloj. */
  tipo: 'destino' | 'encuentro' | 'llegada' | 'vence';
  /** Lo que dice el pictograma, para los lectores de pantalla («Hacia», «Tu chofer te busca en»…). */
  rotulo: string;
  lugar: string;
  /** Lo que falta por las calles, si se sabe (la ruta real). */
  segundos: number | null;
  /** Una línea chica bajo el lugar: la distancia que falta («a 649 m»), si se sabe. */
  detalle?: string | null;
}

/** La cifra grande de la derecha. `antes` va chico arriba («Vence en»). */
export interface Cifra {
  valor: number;
  unidad: string;
  antes?: string;
}

const PICTOGRAMA = { destino: IconoDireccion, encuentro: IconoPin, llegada: IconoLlegada, vence: IconoVence } as const;

/**
 * La línea grande del cartel verde de ruta: el pictograma (como en los carteles de Vialidad, que dicen
 * la dirección con una flecha y no con una palabra), el lugar y, a la derecha, la cifra grande.
 * Va dentro de un `.cartel` (pasajero, chofer y la oferta).
 */
export function CartelDestino({ cartel, cifra }: { cartel: Cartel; cifra?: Cifra | null }) {
  const Pictograma = PICTOGRAMA[cartel.tipo];
  const grande: Cifra | null =
    cifra !== undefined ? cifra : cartel.segundos !== null ? { valor: Math.max(1, Math.round(cartel.segundos / 60)), unidad: 'min' } : null;
  return (
    <div className="cartel-destino">
      <div className="cartel-lugar">
        <Pictograma className="cartel-pictograma" />
        <p>
          <span className="solo-lector">{cartel.rotulo} </span>
          <strong>{cartel.lugar}</strong>
          {cartel.detalle ? <span className="cartel-detalle">{cartel.detalle}</span> : null}
        </p>
      </div>
      {grande ? (
        // Los espacios van en el texto: un lector de pantalla (y los E2E) leen «Vence en 13 s».
        <p className="cartel-minutos">
          {grande.antes ? <span className="cartel-antes">{grande.antes} </span> : null}
          <strong>{grande.valor}</strong>
          <span> {grande.unidad}</span>
        </p>
      ) : null}
    </div>
  );
}
