import { ErrorDeDominio } from '@viajes/kernel';

export class IdentificadorEnUso extends ErrorDeDominio {
  constructor() {
    super('IDENTIFICADOR_EN_USO', 'CONFLICTO', 'Ese email ya está registrado');
  }
}

export class RolNoRegistrable extends ErrorDeDominio {
  constructor() {
    super('ROL_NO_REGISTRABLE', 'PROHIBIDO', 'Ese rol no se puede crear por el registro público');
  }
}

/** Mismo error para email inexistente y contraseña incorrecta: no revelamos qué cuentas existen. */
export class CredencialesInvalidas extends ErrorDeDominio {
  constructor() {
    super('CREDENCIALES_INVALIDAS', 'NO_AUTENTICADO', 'Email o contraseña incorrectos');
  }
}
