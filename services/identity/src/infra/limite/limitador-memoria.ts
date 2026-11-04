import type { Reloj } from '@viajes/kernel';
import type { EstadoLimite, LimitadorLogin } from '../../dominio/puertos/index.js';
import { huellaEmail, resumir, type ParametrosLimite } from './comun.js';

/** Para tests de dominio y para correr sin Redis. No sirve con más de una réplica. */
export class LimitadorLoginMemoria implements LimitadorLogin {
  private readonly contadores = new Map<string, { valor: number; venceEn: number }>();

  constructor(
    private readonly parametros: ParametrosLimite,
    private readonly reloj: Reloj,
  ) {}

  async contar({ email, ip }: { email: string; ip: string }): Promise<EstadoLimite> {
    const { maxPorEmail, maxPorIp } = this.parametros;
    return resumir([
      { ...this.incrementar(`email:${huellaEmail(email)}`), limite: maxPorEmail },
      { ...this.incrementar(`ip:${ip}`), limite: maxPorIp },
    ]);
  }

  async reiniciar(email: string): Promise<void> {
    this.contadores.delete(`email:${huellaEmail(email)}`);
  }

  private incrementar(clave: string) {
    const ahora = this.reloj.ahora().getTime();
    const actual = this.contadores.get(clave);
    const vigente =
      actual && actual.venceEn > ahora
        ? { ...actual, valor: actual.valor + 1 }
        : { valor: 1, venceEn: ahora + this.parametros.ventanaMs };
    this.contadores.set(clave, vigente);
    return { valor: vigente.valor, ttlMs: vigente.venceEn - ahora };
  }
}
