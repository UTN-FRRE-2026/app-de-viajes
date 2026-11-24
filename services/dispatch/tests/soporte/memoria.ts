import { randomUUID } from 'node:crypto';
import type { Reloj } from '@viajes/kernel';
import { crearCasosDeUso } from '../../src/dominio/casos-uso/index.js';
import type { Coordenada } from '../../src/dominio/entidades/index.js';
import type { ElegibilidadChoferes, MetricasDespacho } from '../../src/dominio/puertos/index.js';
import { BuscadorCandidatosFijo } from '../../src/infra/externos/buscador-fijo.js';
import { RepositorioDespachoMemoria } from '../../src/infra/memoria/repositorio-memoria.js';
import { RepositorioTarifasMemoria } from '../../src/infra/memoria/tarifas-memoria.js';
import { MapasFalso, PARAMETROS_PRUEBA, tarifasFijas } from './mapas-falso.js';
import { PagosFalso } from './pagos-falso.js';

export class RelojFalso implements Reloj {
  constructor(private t = new Date('2026-10-28T12:00:00Z')) {}
  ahora() {
    return new Date(this.t);
  }
  avanzar(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export const TTL_MS = 15_000;

/** Los cinco valores de PARAMETROS_PRUEBA, como semilla. */
export const VALORES_PRUEBA = {
  bajadaCentavos: PARAMETROS_PRUEBA.bajadaCentavos,
  centavosPorKm: PARAMETROS_PRUEBA.centavosPorKm,
  centavosPorMinuto: PARAMETROS_PRUEBA.centavosPorMinuto,
  minimoCentavos: PARAMETROS_PRUEBA.minimoCentavos,
  maxMetros: PARAMETROS_PRUEBA.maxMetros,
};

/** Anota lo que registran los casos de uso, para comprobar qué se cuenta y cuándo. */
export class MetricasEnMemoria implements MetricasDespacho {
  readonly solicitudes: string[] = [];
  readonly asignaciones: number[] = [];
  readonly vencidas: number[] = [];
  solicitudCreada(resultado: 'con_ofertas' | 'sin_choferes') {
    this.solicitudes.push(resultado);
  }
  asignacion(ms: number) {
    this.asignaciones.push(ms);
  }
  ofertasVencidas(cantidad: number) {
    this.vencidas.push(cantidad);
  }
  readonly sinAptos: string[] = [];
  busquedaSinAptos(motivo: string) {
    this.sinAptos.push(motivo);
  }
}

export const ZONA_TEST = 'zona-de-test';
export const FLOTA_TEST = 'flota-de-test';

/**
 * Elegibilidad para los tests de dominio que no son de flotas ni de zonas: todo origen está en una
 * zona y todo chofer es apto, como antes del filtro. Se puede ajustar por test: `fueraDeZona` (ningún
 * origen tiene zona), `noAptos` (choferes que el filtro descarta) y `noAptosAlAceptar` (los que la
 * revalidación de la aceptación rechaza). `consultas` anota cada lote que se filtró.
 */
export class ElegibilidadDeTest implements ElegibilidadChoferes {
  fueraDeZona = false;
  readonly noAptos = new Set<string>();
  readonly noAptosAlAceptar = new Set<string>();
  readonly consultas: string[][] = [];

  async zonaDelOrigen(_origen: Coordenada) {
    return this.fueraDeZona ? null : ZONA_TEST;
  }
  async aptos(ids: readonly string[], _zonaId: string) {
    this.consultas.push([...ids]);
    return ids.filter((id) => !this.noAptos.has(id));
  }
  async choferAptoParaAceptar(choferId: string, _zonaId: string) {
    return this.noAptos.has(choferId) || this.noAptosAlAceptar.has(choferId) ? null : { flotaId: FLOTA_TEST };
  }
}

export function sistemaEnMemoria(choferes: string[] = [], ofertasSimultaneas = 3) {
  const repo = new RepositorioDespachoMemoria();
  const elegibilidad = new ElegibilidadDeTest();
  repo.elegibilidad = elegibilidad;
  const buscador = new BuscadorCandidatosFijo(choferes);
  const reloj = new RelojFalso();
  const metricas = new MetricasEnMemoria();
  const mapas = new MapasFalso();
  const pagos = new PagosFalso();
  const tarifas = tarifasFijas();
  const casos = crearCasosDeUso({
    repo,
    buscador,
    elegibilidad,
    reloj,
    ids: { nuevo: () => randomUUID() },
    parametros: { ofertasSimultaneas, ttlOfertaMs: TTL_MS },
    metricas,
    mapas,
    tarifas,
    pagos,
    repoTarifas: new RepositorioTarifasMemoria(),
    semillaTarifa: VALORES_PRUEBA,
  });
  const ofertasDe = (solicitudId: string) =>
    [...repo.ofertas.values()].filter((o) => o.solicitudId === solicitudId);
  return { repo, buscador, elegibilidad, reloj, casos, ofertasDe, metricas, mapas, pagos, tarifas };
}

export const ORIGEN = { lat: -34.6037, lng: -58.3816 };
export const DESTINO = { lat: -34.5875, lng: -58.4207 };

export const uuids = (n: number) => Array.from({ length: n }, () => randomUUID());
