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

/** Mismo error si no existe, venció, fue revocado o se reusó: el cliente solo puede volver a hacer login. */
export class RefreshInvalido extends ErrorDeDominio {
  constructor() {
    super('REFRESH_INVALIDO', 'NO_AUTENTICADO', 'La sesión no es válida. Volvé a iniciar sesión');
  }
}
