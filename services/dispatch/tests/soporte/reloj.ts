import { AsyncLocalStorage } from 'node:async_hooks';
import type { Reloj } from '@viajes/kernel';

/**
 * Un reloj que da la hora del sistema, salvo dentro de `en(hora, trabajo)`: ahí, y en todo lo que ese
 * trabajo espere, da `hora`. Sirve para que un barrido corra «después del vencimiento» mientras una
 * aceptación por HTTP, en el mismo proceso y al mismo tiempo, sigue viendo la hora real: es lo que pasa
 * con dos réplicas cuando la aceptación llega justo antes de vencer y el barrido justo después.
 */
export function relojPorContexto() {
  const hora = new AsyncLocalStorage<Date>();
  const reloj: Reloj = { ahora: () => new Date(hora.getStore() ?? Date.now()) };
  return {
    reloj,
    en: <T>(ahora: Date, trabajo: () => Promise<T>): Promise<T> => hora.run(ahora, trabajo),
  };
}
