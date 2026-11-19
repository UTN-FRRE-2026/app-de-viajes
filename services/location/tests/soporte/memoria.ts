import type { Reloj } from '@viajes/kernel';
import { crearCasosDeUso } from '../../src/dominio/casos-uso/index.js';
import type { RepositorioUbicaciones } from '../../src/dominio/puertos/index.js';
import { RepositorioUbicacionesMemoria } from '../../src/infra/memoria/repositorio-memoria.js';

export class RelojFalso implements Reloj {
  constructor(private t = new Date('2026-11-19T12:00:00Z')) {}
  ahora() {
    return new Date(this.t);
  }
  avanzar(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export const VIGENCIA_MS = 30_000;

/** Casos de uso sobre cualquier repositorio: los mismos tests corren en memoria y contra Postgres. */
export function sistemaCon(repo: RepositorioUbicaciones, reloj = new RelojFalso()) {
  return { repo, reloj, casos: crearCasosDeUso({ repo, reloj, vigenciaMs: VIGENCIA_MS }) };
}

export const sistemaEnMemoria = () => sistemaCon(new RepositorioUbicacionesMemoria());

/** Obelisco de Buenos Aires: origen de todas las búsquedas de los tests. */
export const OBELISCO = { lat: -34.6037, lng: -58.3816 };

/** Un punto `metros` al norte del origen (1° de latitud ≈ 111 195 m). */
export const alNorte = (metros: number) => ({ lat: OBELISCO.lat + metros / 111_195, lng: OBELISCO.lng });
