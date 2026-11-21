import { randomUUID } from 'node:crypto';
import type { CasosDeFlotas } from '../../src/dominio/casos-uso/flotas.js';
import type { DirectorioFalso } from './directorio-falso.js';

const letra = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
/** Una patente Mercosur al azar (AB123CD): 457 millones de combinaciones, no se repiten en un test. */
export function patenteNueva(): string {
  return `${letra()}${letra()}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}${letra()}${letra()}`;
}

export const vehiculo = () => ({ patente: patenteNueva(), marca: 'Toyota', modelo: 'Etios' });

/**
 * Prepara datos de flotas por los casos de uso (sin HTTP): la flota, choferes dados de alta en ella
 * y, si se pide, habilitados. Cada chofer es una cuenta de chofer en el directorio falso.
 */
export function preparadorFlotas(casos: CasosDeFlotas, directorio: DirectorioFalso) {
  return {
    async flota(maxActivos: number, id = randomUUID()) {
      return casos.guardarFlota({ id, nombre: `Flota ${id.slice(0, 4)}`, maxActivos });
    },
    async chofer(flotaId: string, { habilitado = true } = {}) {
      const id = directorio.registrar(randomUUID(), 'chofer');
      await casos.altaChofer({ fleetId: flotaId }, { choferId: id, vehiculo: vehiculo() });
      if (habilitado) await casos.habilitarChofer(id);
      return id;
    },
    async choferes(flotaId: string, cantidad: number, opciones: { habilitado?: boolean } = {}) {
      const ids: string[] = [];
      for (let i = 0; i < cantidad; i++) ids.push(await this.chofer(flotaId, opciones));
      return ids;
    },
  };
}
