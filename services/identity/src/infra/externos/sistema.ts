import { randomUUID } from 'node:crypto';
import type { GeneradorId, Reloj } from '@viajes/kernel';

export const relojSistema: Reloj = { ahora: () => new Date() };
export const idsAleatorios: GeneradorId = { nuevo: () => randomUUID() };
