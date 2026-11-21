import type { RepositorioTarifas } from '../../dominio/puertos/index.js';
import { AUTOR_SEMILLA, type TarifaVigente, type ValoresTarifa } from '../../dominio/tarifas/parametros.js';

export interface CambioTarifaMemoria {
  version: string;
  versionAnterior: string | null;
  cambiadaPor: string;
  valoresAnteriores: ValoresTarifa | null;
  valoresNuevos: ValoresTarifa;
}

const valoresDe = (t: ValoresTarifa): ValoresTarifa => ({
  bajadaCentavos: t.bajadaCentavos,
  centavosPorKm: t.centavosPorKm,
  centavosPorMinuto: t.centavosPorMinuto,
  minimoCentavos: t.minimoCentavos,
  maxMetros: t.maxMetros,
});

/**
 * Tarifa versionada en memoria: para el modo `DISPATCH_PERSISTENCIA=memoria` y los tests de dominio.
 * Cada operación es sincrónica dentro del event loop, así que no hace falta un lock.
 */
export class RepositorioTarifasMemoria implements RepositorioTarifas {
  readonly versiones: TarifaVigente[] = [];
  readonly cambios: CambioTarifaMemoria[] = [];
  private actual: TarifaVigente | null = null;

  constructor(private readonly ahora: () => Date = () => new Date()) {}

  async versionVigente() {
    return this.actual?.version ?? null;
  }

  async porVersion(version: string) {
    const t = this.versiones.find((v) => v.version === version);
    return t ? { ...t } : null;
  }

  async vigente() {
    return this.actual ? { ...this.actual } : null;
  }

  async sembrar(valores: ValoresTarifa) {
    if (this.versiones.length > 0) return;
    this.agregar(valores, AUTOR_SEMILLA);
  }

  async reemplazar(valores: ValoresTarifa, autor: string) {
    return { ...this.agregar(valores, autor) };
  }

  private agregar(valores: ValoresTarifa, autor: string): TarifaVigente {
    const anterior = this.actual;
    const tarifa: TarifaVigente = {
      version: `v${this.versiones.length + 1}`,
      moneda: 'ARS',
      ...valoresDe(valores),
      actualizadaPor: autor,
      actualizadaEn: this.ahora(),
    };
    this.versiones.push(tarifa);
    this.cambios.push({
      version: tarifa.version,
      versionAnterior: anterior?.version ?? null,
      cambiadaPor: autor,
      valoresAnteriores: anterior ? valoresDe(anterior) : null,
      valoresNuevos: valoresDe(valores),
    });
    this.actual = tarifa;
    return tarifa;
  }
}
