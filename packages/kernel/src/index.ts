// Lo único que el dominio de cualquier servicio puede importar.

/**
 * Categoría del error, independiente del transporte. La capa HTTP la traduce
 * (NO_ENCONTRADO → 404, CONFLICTO → 409, INVALIDO → 422, PROHIBIDO → 403).
 */
export type TipoError = 'NO_ENCONTRADO' | 'CONFLICTO' | 'INVALIDO' | 'PROHIBIDO';

export class ErrorDeDominio extends Error {
  constructor(
    readonly codigo: string,
    readonly tipo: TipoError,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'ErrorDeDominio';
  }
}

export interface Reloj {
  ahora(): Date;
}

export interface GeneradorId {
  nuevo(): string;
}
