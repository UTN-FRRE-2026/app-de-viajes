import { ErrorDeDominio } from '@viajes/kernel';

export class CoordenadaInvalida extends ErrorDeDominio {
  constructor() {
    super('COORDENADA_INVALIDA', 'INVALIDO', 'La latitud va de -90 a 90 y la longitud de -180 a 180');
  }
}
