import type { DirectorioUsuarios } from '../../src/dominio/puertos/index.js';

/** Las cuentas de identity, en memoria: los tests registran qué ids existen y con qué rol. */
export class DirectorioFalso implements DirectorioUsuarios {
  readonly cuentas = new Map<string, string>();
  registrar(id: string, rol: string) {
    this.cuentas.set(id, rol);
    return id;
  }

  async rolDe(usuarioId: string) {
    return this.cuentas.get(usuarioId) ?? null;
  }
}
