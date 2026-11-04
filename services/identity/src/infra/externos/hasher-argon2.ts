import { randomUUID } from 'node:crypto';
import { argon2id, hash, verify } from 'argon2';
import type { HasherContrasenas } from '../../dominio/puertos/index.js';

export interface ParametrosArgon2 {
  memoriaKib: number;
  iteraciones: number;
  paralelismo: number;
}

/** Piso de OWASP para argon2id: 19 MiB, 2 iteraciones, 1 hilo. Ver docs/identity.md. */
export const PARAMETROS_ARGON2: ParametrosArgon2 = { memoriaKib: 19_456, iteraciones: 2, paralelismo: 1 };

export class HasherArgon2 implements HasherContrasenas {
  private senuelo?: Promise<string>;

  constructor(private readonly parametros: ParametrosArgon2 = PARAMETROS_ARGON2) {}

  hashear(contrasena: string): Promise<string> {
    const { memoriaKib, iteraciones, paralelismo } = this.parametros;
    return hash(contrasena, { type: argon2id, memoryCost: memoriaKib, timeCost: iteraciones, parallelism: paralelismo });
  }

  // Los parámetros se leen del hash guardado (formato PHC), no de la configuración actual.
  verificar(hashGuardado: string, contrasena: string): Promise<boolean> {
    return verify(hashGuardado, contrasena);
  }

  async simularVerificacion(contrasena: string): Promise<void> {
    // El señuelo se calcula una sola vez, con una contraseña aleatoria que nadie conoce.
    this.senuelo ??= this.hashear(randomUUID());
    await verify(await this.senuelo, contrasena);
  }
}
