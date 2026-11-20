import { describe, expect, it } from 'vitest';
import { conTiempoLimite } from '../../src/infra/db/salud.js';

describe('chequeos de /ready con tiempo límite', () => {
  it('un chequeo colgado falla a tiempo, con un mensaje claro', async () => {
    const colgado = conTiempoLimite({ nombre: 'postgres', chequear: () => new Promise<void>(() => undefined) }, 50);
    const inicio = Date.now();
    await expect(colgado.chequear()).rejects.toThrow('sin respuesta en 50 ms');
    expect(Date.now() - inicio).toBeLessThan(1000);
  });

  it('un chequeo que responde pasa, y uno que falla conserva su error', async () => {
    await expect(conTiempoLimite({ nombre: 'ok', chequear: async () => undefined }, 50).chequear()).resolves.toBeUndefined();
    await expect(
      conTiempoLimite({ nombre: 'mal', chequear: async () => Promise.reject(new Error('conexión rechazada')) }, 50).chequear(),
    ).rejects.toThrow('conexión rechazada');
  });
});
