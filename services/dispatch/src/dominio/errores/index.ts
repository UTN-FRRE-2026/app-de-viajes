import { ErrorDeDominio } from '@viajes/kernel';

export class SolicitudNoEncontrada extends ErrorDeDominio {
  constructor() {
    super('SOLICITUD_NO_ENCONTRADA', 'NO_ENCONTRADO', 'La solicitud no existe');
  }
}

/** También se usa cuando la oferta es de otro chofer: no revelamos que existe. */
export class OfertaNoEncontrada extends ErrorDeDominio {
  constructor() {
    super('OFERTA_NO_ENCONTRADA', 'NO_ENCONTRADO', 'La oferta no existe');
  }
}

export class SolicitudNoDisponible extends ErrorDeDominio {
  constructor(estado: string) {
    super('SOLICITUD_NO_DISPONIBLE', 'CONFLICTO', `La solicitud ya no está buscando chofer (estado ${estado})`);
  }
}

export class OfertaVencida extends ErrorDeDominio {
  constructor() {
    super('OFERTA_VENCIDA', 'CONFLICTO', 'La oferta venció o ya no está pendiente');
  }
}

export class ChoferConViajeActivo extends ErrorDeDominio {
  constructor() {
    super('CHOFER_CON_VIAJE_ACTIVO', 'CONFLICTO', 'El chofer ya tiene un viaje activo');
  }
}

export class SolicitudActivaExistente extends ErrorDeDominio {
  constructor() {
    super('SOLICITUD_ACTIVA_EXISTENTE', 'CONFLICTO', 'Ya tenés una solicitud activa');
  }
}

export class SolicitudNoCancelable extends ErrorDeDominio {
  constructor(estado: string) {
    super('SOLICITUD_NO_CANCELABLE', 'CONFLICTO', `No se puede cancelar una solicitud en estado ${estado}`);
  }
}
