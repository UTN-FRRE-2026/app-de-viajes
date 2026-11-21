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

/** El viaje no está en el estado que la acción necesita (por ejemplo, finalizar uno que no empezó). */
export class TransicionInvalida extends ErrorDeDominio {
  constructor(estado: string, hacia: string) {
    super('TRANSICION_INVALIDA', 'CONFLICTO', `No se puede pasar de ${estado} a ${hacia}`);
  }
}

/** El recorrido supera el máximo de la tarifa: no se estima ni se acepta. */
export class ViajeFueraDeRango extends ErrorDeDominio {
  constructor(maxMetros: number) {
    super('VIAJE_FUERA_DE_RANGO', 'INVALIDO', `El recorrido supera el máximo permitido (${maxMetros / 1000} km)`);
  }
}

/** Los valores de la tarifa no cumplen los invariantes del dominio. */
export class TarifaInvalida extends ErrorDeDominio {
  constructor(problemas: string[]) {
    super('TARIFA_INVALIDA', 'INVALIDO', `La tarifa no es válida: ${problemas.join('; ')}`);
  }
}

export class MotivoRequerido extends ErrorDeDominio {
  constructor() {
    super('MOTIVO_REQUERIDO', 'INVALIDO', 'El operador tiene que indicar el motivo de la cancelación');
  }
}

/** Viaje sin cobro: no existe, es de otro pasajero, o todavía no terminó. */
export class CobroNoEncontrado extends ErrorDeDominio {
  constructor() {
    super('COBRO_NO_ENCONTRADO', 'NO_ENCONTRADO', 'El viaje no tiene un cobro');
  }
}

/** Un cobro ya aprobado o rechazado no cambia más. */
export class CobroNoPendiente extends ErrorDeDominio {
  constructor(estado: string) {
    super('COBRO_NO_PENDIENTE', 'CONFLICTO', `El cobro ya está ${estado}`);
  }
}

// Flotas (variante G).

/** También cuando el chofer es de otra flota: no revelamos que existe. */
export class ChoferNoEncontrado extends ErrorDeDominio {
  constructor() {
    super('CHOFER_NO_ENCONTRADO', 'NO_ENCONTRADO', 'El chofer no existe');
  }
}

export class FlotaNoEncontrada extends ErrorDeDominio {
  constructor() {
    super('FLOTA_NO_ENCONTRADA', 'NO_ENCONTRADO', 'La flota no existe');
  }
}

/** Un admin_flota cuyo token no trae `fleetId`. */
export class FlotaNoAsignada extends ErrorDeDominio {
  constructor() {
    super('FLOTA_NO_ASIGNADA', 'PROHIBIDO', 'Tu usuario no tiene una flota asignada');
  }
}

export class LimiteFlotaAlcanzado extends ErrorDeDominio {
  constructor() {
    super('LIMITE_FLOTA_ALCANZADO', 'CONFLICTO', 'La flota ya tiene el máximo de choferes activos');
  }
}

export class LimiteMenorQueActivos extends ErrorDeDominio {
  constructor() {
    super('LIMITE_MENOR_QUE_ACTIVOS', 'CONFLICTO', 'El límite no puede ser menor que los choferes activos');
  }
}

export class ChoferNoHabilitado extends ErrorDeDominio {
  constructor() {
    super('CHOFER_NO_HABILITADO', 'CONFLICTO', 'El chofer no está habilitado');
  }
}

export class ChoferNoActivo extends ErrorDeDominio {
  constructor() {
    super('CHOFER_NO_ACTIVO', 'CONFLICTO', 'El chofer no está activo en su flota');
  }
}

export class ChoferYaRegistrado extends ErrorDeDominio {
  constructor() {
    super('CHOFER_YA_REGISTRADO', 'CONFLICTO', 'El chofer ya pertenece a una flota');
  }
}

export class PatenteYaRegistrada extends ErrorDeDominio {
  constructor() {
    super('PATENTE_YA_REGISTRADA', 'CONFLICTO', 'Esa patente ya está registrada');
  }
}

/** Mismo error si la cuenta no existe o no es de chofer: no revelamos qué cuentas existen. */
export class CuentaNoEsChofer extends ErrorDeDominio {
  constructor() {
    super('CUENTA_NO_ES_CHOFER', 'INVALIDO', 'El usuario no existe o no es chofer');
  }
}
