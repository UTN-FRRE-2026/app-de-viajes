import type { Coordenada } from '../../dominio/entidades/index.js';
import type { DatosZona, ElegibilidadChoferes } from '../../dominio/puertos/index.js';
import type { RepositorioFlotasMemoria } from './flotas-memoria.js';
import type { RepositorioDespachoMemoria } from './repositorio-memoria.js';

type Punto = [number, number];

const EPS = 1e-12;

/** Orientación de c respecto del segmento ab: >0 izquierda, <0 derecha, 0 colineal. */
const orientacion = (a: Punto, b: Punto, c: Punto) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function enSegmento(p: Punto, a: Punto, b: Punto): boolean {
  return (
    Math.abs(orientacion(a, b, p)) < EPS &&
    p[0] >= Math.min(a[0], b[0]) - EPS &&
    p[0] <= Math.max(a[0], b[0]) + EPS &&
    p[1] >= Math.min(a[1], b[1]) - EPS &&
    p[1] <= Math.max(a[1], b[1]) + EPS
  );
}

const lados = (anillo: Punto[]) => anillo.slice(0, -1).map((a, i) => [a, anillo[i + 1]!] as const);

/** 'borde', 'adentro' o 'afuera' (rayo horizontal). Como ST_Covers: el borde cuenta. */
export function ubicarPunto(p: Punto, anillo: Punto[]): 'borde' | 'adentro' | 'afuera' {
  let adentro = false;
  for (const [a, b] of lados(anillo)) {
    if (enSegmento(p, a, b)) return 'borde';
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) adentro = !adentro;
  }
  return adentro ? 'adentro' : 'afuera';
}

/** Dos segmentos se cruzan en un punto interior de los dos (no solo se tocan). */
function seCruzan(a: Punto, b: Punto, c: Punto, d: Punto): boolean {
  const o1 = orientacion(a, b, c);
  const o2 = orientacion(a, b, d);
  const o3 = orientacion(c, d, a);
  const o4 = orientacion(c, d, b);
  return o1 * o2 < -EPS && o3 * o4 < -EPS;
}

/**
 * Comparten interior, como `ST_Intersects AND NOT ST_Touches`, para polígonos simples: se cruzan dos
 * lados, o un vértice (o el punto medio de un lado) de uno está estrictamente adentro del otro.
 */
export function seSuperponen(x: Punto[], y: Punto[]): boolean {
  for (const [a, b] of lados(x)) for (const [c, d] of lados(y)) if (seCruzan(a, b, c, d)) return true;
  const muestras = (anillo: Punto[]) => [
    ...anillo,
    ...lados(anillo).map(([a, b]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Punto),
  ];
  return muestras(x).some((p) => ubicarPunto(p, y) === 'adentro') || muestras(y).some((p) => ubicarPunto(p, x) === 'adentro');
}

/** Un anillo válido para la versión en memoria: cerrado, con área y sin lados que se crucen. */
export function motivoInvalida(anillo: Punto[]): string | null {
  const ls = lados(anillo);
  for (let i = 0; i < ls.length; i++) {
    for (let j = i + 2; j < ls.length; j++) {
      if (i === 0 && j === ls.length - 1) continue;
      if (seCruzan(ls[i]![0], ls[i]![1], ls[j]![0], ls[j]![1])) return 'Self-intersection';
    }
  }
  const area = ls.reduce((s, [a, b]) => s + (a[0] * b[1] - b[0] * a[1]), 0) / 2;
  return Math.abs(area) < EPS ? 'Too few points' : null;
}

/** La zona que cubre el punto; en un borde compartido, la de menor id (como en Postgres). */
export function zonaQueCubre(zonas: Iterable<DatosZona>, { lat, lng }: Coordenada): string | null {
  const ids = [...zonas].filter((z) => ubicarPunto([lng, lat], z.anillo) !== 'afuera').map((z) => z.id);
  return ids.sort()[0] ?? null;
}

/**
 * Elegibilidad en memoria (`DISPATCH_PERSISTENCIA=memoria`): las mismas reglas que el SQL de
 * `ElegibilidadPrisma`, sobre los choferes y zonas de las flotas en memoria y las asignaciones del
 * repositorio de despacho. También responde la revalidación de la aceptación.
 */
export class ElegibilidadMemoria implements ElegibilidadChoferes {
  constructor(
    private readonly flotas: RepositorioFlotasMemoria,
    private readonly despacho: RepositorioDespachoMemoria,
  ) {}

  async zonaDelOrigen(origen: Coordenada) {
    return zonaQueCubre(this.flotas.zonas.values(), origen);
  }

  async aptos(ids: readonly string[], zonaId: string) {
    return ids.filter((id) => this.aptoAhora(id, zonaId) !== null && !this.despacho.asignaciones.has(id));
  }

  async choferAptoParaAceptar(choferId: string, zonaId: string) {
    return this.aptoAhora(choferId, zonaId);
  }

  private aptoAhora(choferId: string, zonaId: string): { flotaId: string } | null {
    const c = this.flotas.choferes.get(choferId);
    if (!c || !c.habilitado || !c.activo || !c.disponible) return null;
    return this.flotas.zonasPorFlota.get(c.flotaId)?.has(zonaId) ? { flotaId: c.flotaId } : null;
  }
}
