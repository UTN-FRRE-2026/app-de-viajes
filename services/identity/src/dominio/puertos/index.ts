import type { Rol, Usuario } from '../entidades/index.js';

export interface RepositorioUsuarios {
  /** false si el email ya existe. La unicidad la garantiza la base, no un chequeo previo. */
  insertar(usuario: Usuario): Promise<boolean>;
  buscarPorEmail(email: string): Promise<Usuario | null>;
}

export interface HasherContrasenas {
  hashear(contrasena: string): Promise<string>;
  verificar(hash: string, contrasena: string): Promise<boolean>;
  /** Hace el mismo trabajo que `verificar` cuando no hay usuario: así el tiempo de respuesta no lo delata. */
  simularVerificacion(contrasena: string): Promise<void>;
}

export interface ClaimsToken {
  sub: string;
  rol: Rol;
  fleetId?: string;
}

export interface TokenEmitido {
  token: string;
  expiraEnSegundos: number;
}

/** JWK público: los únicos campos que se pueden publicar. */
export interface ClavePublica {
  kty: string;
  n: string;
  e: string;
  kid: string;
  alg: string;
  use: string;
}

export interface EmisorTokens {
  emitir(claims: ClaimsToken): Promise<TokenEmitido>;
  clavesPublicas(): ClavePublica[];
}

export interface EstadoLimite {
  limite: number;
  restantes: number;
  /** Segundos hasta que se reinicia la ventana. */
  reinicioSegundos: number;
  excedido: boolean;
}

export interface LimitadorLogin {
  /**
   * Cuenta el intento de forma atómica ANTES de verificar la contraseña: así los pedidos
   * simultáneos no pasan todos juntos. Lanza si el almacén no responde (se falla cerrado).
   */
  contar(intento: { email: string; ip: string }): Promise<EstadoLimite>;
  /** Login correcto: limpia el contador del email. El de la IP sigue corriendo. */
  reiniciar(email: string): Promise<void>;
}
