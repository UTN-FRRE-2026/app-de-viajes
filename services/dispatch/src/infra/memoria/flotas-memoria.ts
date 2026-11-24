import { ChoferFlota, type DatosChoferFlota, type DatosFlota, type Flota } from '../../dominio/flotas/index.js';
import type { DatosZona, Pagina, RepositorioFlotas, TransaccionFlotas } from '../../dominio/puertos/index.js';
import { motivoInvalida, seSuperponen } from './zonas-memoria.js';

/**
 * Flotas en memoria: para `DISPATCH_PERSISTENCIA=memoria` y los tests de dominio.
 * Emula lo que garantiza Postgres en el adaptador real:
 * - una transacción por vez (un mutex): reemplaza al FOR UPDATE del chofer y al lock de la flota;
 * - los cambios se aplican al final y solo si el trabajo no lanzó (rollback);
 * - las restricciones: cupo entre 0 y el límite, chofer único, patente única, activo → habilitado,
 *   disponible → activo.
 * La carrera G de verdad se prueba contra Postgres (tests/concurrencia/flotas.test.ts).
 */
export class RepositorioFlotasMemoria implements RepositorioFlotas {
  readonly flotas = new Map<string, Flota>();
  readonly choferes = new Map<string, DatosChoferFlota>();
  /** Zonas operativas y las de cada flota (flotaId → zonas). Se escriben al confirmar, como lo demás. */
  readonly zonas = new Map<string, DatosZona>();
  readonly zonasPorFlota = new Map<string, Set<string>>();
  private cola: Promise<void> = Promise.resolve();

  async enTransaccion<T>(trabajo: (tx: TransaccionFlotas) => Promise<T>): Promise<T> {
    let soltar!: () => void;
    const turno = new Promise<void>((r) => (soltar = r));
    const anterior = this.cola;
    this.cola = anterior.then(() => turno);
    await anterior;
    try {
      const flotas = new Map([...this.flotas].map(([id, f]) => [id, { ...f }]));
      const choferes = new Map([...this.choferes].map(([id, c]) => [id, { ...c, vehiculo: { ...c.vehiculo } }]));
      const zonas = new Map(this.zonas);
      const zonasPorFlota = new Map([...this.zonasPorFlota].map(([id, s]) => [id, new Set(s)]));
      const resultado = await trabajo(this.transaccion(flotas, choferes, zonas, zonasPorFlota));
      for (const f of flotas.values()) {
        if (f.activos < 0 || f.activos > f.maxActivos) throw new Error('fleets_cupo_check');
      }
      for (const c of choferes.values()) {
        if ((c.activo && !c.habilitado) || (c.disponible && !c.activo)) throw new Error('drivers check');
      }
      this.flotas.clear();
      for (const [id, f] of flotas) this.flotas.set(id, f);
      this.choferes.clear();
      for (const [id, c] of choferes) this.choferes.set(id, c);
      this.zonas.clear();
      for (const [id, z] of zonas) this.zonas.set(id, z);
      this.zonasPorFlota.clear();
      for (const [id, s] of zonasPorFlota) this.zonasPorFlota.set(id, s);
      return resultado;
    } finally {
      soltar();
    }
  }

  private transaccion(
    flotas: Map<string, Flota>,
    choferes: Map<string, DatosChoferFlota>,
    zonas: Map<string, DatosZona>,
    zonasPorFlota: Map<string, Set<string>>,
  ): TransaccionFlotas {
    return {
      async obtenerChoferParaActualizar(id) {
        const c = choferes.get(id);
        return c ? ChoferFlota.reconstruir(c) : null;
      },
      async guardarChofer(chofer) {
        choferes.set(chofer.id, chofer.aDatos());
      },
      async insertarChofer(chofer) {
        const d = chofer.aDatos();
        if (choferes.has(d.id)) return 'chofer_existe';
        if ([...choferes.values()].some((c) => c.vehiculo.patente === d.vehiculo.patente)) return 'patente_existe';
        choferes.set(d.id, d);
        return 'ok';
      },
      async ocuparCupo(flotaId) {
        const f = flotas.get(flotaId);
        if (!f || f.activos >= f.maxActivos) return false;
        f.activos += 1;
        return true;
      },
      async liberarCupo(flotaId) {
        const f = flotas.get(flotaId);
        if (f) f.activos -= 1;
      },
      async guardarFlota({ id, nombre, maxActivos }: DatosFlota) {
        const f = flotas.get(id);
        if (f && f.activos > maxActivos) return 'limite_menor';
        flotas.set(id, { id, nombre, maxActivos, activos: f?.activos ?? 0 });
        return 'ok';
      },
      async obtenerFlota(id) {
        const f = flotas.get(id);
        return f ? { ...f } : null;
      },
      async guardarZona(zona) {
        const motivo = motivoInvalida(zona.anillo);
        if (motivo) return { resultado: 'invalida', motivo };
        const otra = [...zonas.values()]
          .filter((z) => z.id !== zona.id)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .find((z) => seSuperponen(z.anillo, zona.anillo));
        if (otra) return { resultado: 'superpuesta', con: otra.nombre };
        zonas.set(zona.id, { ...zona, anillo: zona.anillo.map((p) => [...p] as [number, number]) });
        return { resultado: 'ok' };
      },
      async reemplazarZonasDeFlota(flotaId, ids) {
        if (!flotas.has(flotaId)) return 'flota_no_existe';
        if (ids.some((id) => !zonas.has(id))) return 'zona_no_existe';
        zonasPorFlota.set(flotaId, new Set(ids));
        return 'ok';
      },
      async obtenerZona(id) {
        return zonas.get(id) ?? null;
      },
      async zonasDeFlota(flotaId) {
        return [...(zonasPorFlota.get(flotaId) ?? [])].sort();
      },
    };
  }

  async listarZonas() {
    return [...this.zonas.values()].sort((a, b) => a.nombre.localeCompare(b.nombre) || (a.id < b.id ? -1 : 1));
  }

  async zonasDeFlota(flotaId: string) {
    return [...(this.zonasPorFlota.get(flotaId) ?? [])].sort();
  }

  async obtenerFlota(id: string) {
    const f = this.flotas.get(id);
    return f ? { ...f } : null;
  }

  async obtenerChofer(id: string) {
    const c = this.choferes.get(id);
    return c ? ChoferFlota.reconstruir(c) : null;
  }

  async listarChoferes(flotaId: string, { limite, desde }: Pagina) {
    return [...this.choferes.values()]
      .filter((c) => c.flotaId === flotaId)
      .slice(desde, desde + limite)
      .map((c) => ChoferFlota.reconstruir(c));
  }
}
