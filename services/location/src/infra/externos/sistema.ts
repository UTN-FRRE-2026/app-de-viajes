import type { Reloj } from '@viajes/kernel';

export const relojSistema: Reloj = { ahora: () => new Date() };
