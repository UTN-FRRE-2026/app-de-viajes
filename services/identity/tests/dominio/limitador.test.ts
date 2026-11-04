import { describe, expect, it } from 'vitest';
import { resumir } from '../../src/infra/limite/comun.js';
import { LimitadorLoginMemoria } from '../../src/infra/limite/limitador-memoria.js';
import { RelojFalso } from '../soporte/memoria.js';

const VENTANA = 900_000;

function crear(maxPorEmail = 3, maxPorIp = 100) {
  const reloj = new RelojFalso();
  return { reloj, limitador: new LimitadorLoginMemoria({ maxPorEmail, maxPorIp, ventanaMs: VENTANA }, reloj) };
}

const intento = { email: 'ana@viajes.test', ip: '10.0.0.1' };

describe('limitador en memoria', () => {
  it('permite hasta el máximo y excede en el siguiente', async () => {
    const { limitador } = crear();
    const estados = [];
    for (let i = 0; i < 4; i++) estados.push(await limitador.contar(intento));
    expect(estados.map((e) => e.excedido)).toEqual([false, false, false, true]);
    expect(estados.map((e) => e.restantes)).toEqual([2, 1, 0, 0]);
  });

  it('la ventana se reinicia sola al vencer', async () => {
    const { limitador, reloj } = crear(1);
    await limitador.contar(intento);
    expect((await limitador.contar(intento)).excedido).toBe(true);
    reloj.avanzar(VENTANA);
    expect((await limitador.contar(intento)).excedido).toBe(false);
  });

  it('reiniciar limpia el email pero no la IP', async () => {
    const { limitador } = crear(1, 2);
    await limitador.contar(intento);
    await limitador.reiniciar(intento.email);
    expect((await limitador.contar(intento)).excedido).toBe(false);
    await limitador.reiniciar(intento.email);
    expect((await limitador.contar(intento)).excedido).toBe(true);
  });

  it('el límite por IP corta aunque cambie el email', async () => {
    const { limitador } = crear(100, 2);
    await limitador.contar({ ...intento, email: 'a@viajes.test' });
    await limitador.contar({ ...intento, email: 'b@viajes.test' });
    expect((await limitador.contar({ ...intento, email: 'c@viajes.test' })).excedido).toBe(true);
  });

  it('el email de otra persona desde otra IP tiene su propio contador', async () => {
    const { limitador } = crear(1);
    await limitador.contar(intento);
    expect((await limitador.contar({ email: 'otra@viajes.test', ip: '10.0.0.2' })).excedido).toBe(false);
  });
});

describe('resumir', () => {
  it('informa el contador más ajustado y redondea el reinicio hacia arriba', () => {
    expect(
      resumir([
        { valor: 4, limite: 5, ttlMs: 1500 },
        { valor: 1, limite: 30, ttlMs: 9000 },
      ]),
    ).toEqual({ limite: 5, restantes: 1, reinicioSegundos: 2, excedido: false });
  });

  it('con varios excedidos espera al que más tarda', () => {
    expect(
      resumir([
        { valor: 6, limite: 5, ttlMs: 1000 },
        { valor: 31, limite: 30, ttlMs: 8000 },
      ]),
    ).toMatchObject({ excedido: true, restantes: 0, reinicioSegundos: 8 });
  });
});
