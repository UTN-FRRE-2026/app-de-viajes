import { randomUUID } from 'node:crypto';
import type { Reloj } from '@viajes/kernel';
import { crearCasosDeUso } from '../../src/dominio/casos-uso/index.js';
import type {
  ClaimsToken,
  ClavePublica,
  EmisorTokens,
  GeneradorRefresh,
  HasherContrasenas,
  TokenEmitido,
} from '../../src/dominio/puertos/index.js';
import { RepositorioSesionesMemoria, RepositorioUsuariosMemoria } from '../../src/infra/memoria/repositorio-memoria.js';

export class RelojFalso implements Reloj {
  constructor(private t = new Date('2026-11-04T12:00:00Z')) {}
  ahora() {
    return new Date(this.t);
  }
  avanzar(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

/** Sin argon2: los tests de dominio prueban reglas, no criptografía. */
export class HasherFalso implements HasherContrasenas {
  hashes = 0;
  simulaciones = 0;

  async hashear(contrasena: string) {
    this.hashes += 1;
    return `hash:${contrasena}`;
  }
  async verificar(hash: string, contrasena: string) {
    return hash === `hash:${contrasena}`;
  }
  async simularVerificacion() {
    this.simulaciones += 1;
  }
}

export class EmisorFalso implements EmisorTokens {
  readonly emitidos: ClaimsToken[] = [];

  async emitir(claims: ClaimsToken): Promise<TokenEmitido> {
    this.emitidos.push(claims);
    return { token: 'token-falso', expiraEnSegundos: 900 };
  }
  clavesPublicas(): ClavePublica[] {
    return [];
  }
}

/** Tokens predecibles (`refresh-1`, `refresh-2`…) para poder seguirlos en los asserts. */
export class GeneradorRefreshFalso implements GeneradorRefresh {
  private n = 0;

  nuevo() {
    this.n += 1;
    const token = `refresh-${this.n}`;
    return { token, huella: this.huella(token) };
  }
  huella(token: string) {
    return `huella:${token}`;
  }
}

export const REFRESH_TTL_SEGUNDOS = 604_800;

export function sistemaEnMemoria() {
  const repo = new RepositorioUsuariosMemoria();
  const sesiones = new RepositorioSesionesMemoria();
  const hasher = new HasherFalso();
  const emisor = new EmisorFalso();
  const reloj = new RelojFalso();
  const casos = crearCasosDeUso({
    repo,
    sesiones,
    hasher,
    emisor,
    refresh: new GeneradorRefreshFalso(),
    reloj,
    ids: { nuevo: () => randomUUID() },
    refreshTtlSegundos: REFRESH_TTL_SEGUNDOS,
  });
  return { repo, sesiones, hasher, emisor, reloj, casos };
}

export const CONTRASENA = 'una-contrasena-de-prueba';
