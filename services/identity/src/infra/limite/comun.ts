import { createHash } from 'node:crypto';
import type { EstadoLimite } from '../../dominio/puertos/index.js';

export interface ParametrosLimite {
  maxPorEmail: number;
  maxPorIp: number;
  ventanaMs: number;
}

export interface Contador {
  valor: number;
  limite: number;
  ttlMs: number;
}

/** El email se guarda hasheado: en el almacén de contadores no queda ningún dato personal. */
export function huellaEmail(email: string): string {
  return createHash('sha256').update(email).digest('hex');
}

const segundos = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/** Resume varios contadores en un estado: manda el más restrictivo. */
export function resumir(contadores: Contador[]): EstadoLimite {
  const [masAjustado] = [...contadores].sort((a, b) => a.limite - a.valor - (b.limite - b.valor));
  if (!masAjustado) throw new Error('no hay contadores');
  const excedidos = contadores.filter((c) => c.valor > c.limite);
  const reinicio = excedidos.length ? Math.max(...excedidos.map((c) => c.ttlMs)) : masAjustado.ttlMs;
  return {
    limite: masAjustado.limite,
    restantes: Math.max(0, masAjustado.limite - masAjustado.valor),
    reinicioSegundos: segundos(reinicio),
    excedido: excedidos.length > 0,
  };
}
