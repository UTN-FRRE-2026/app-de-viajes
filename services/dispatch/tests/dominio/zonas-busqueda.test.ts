import { ErrorHttp } from '@viajes/platform';
import { describe, expect, it } from 'vitest';
import { lotes } from '../../src/dominio/casos-uso/buscar-aptos.js';
import { SolicitudViaje } from '../../src/dominio/entidades/index.js';
import { BuscadorCandidatosFijo } from '../../src/infra/externos/buscador-fijo.js';
import { DESTINO, FLOTA_TEST, ORIGEN, sistemaEnMemoria, TTL_MS, uuids, ZONA_TEST } from '../soporte/memoria.js';

const [PASAJERO] = uuids(1) as [string];
const pedir = (casos: ReturnType<typeof sistemaEnMemoria>['casos']) =>
  casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });

/** Un buscador que anota el `limite` de cada pedido y puede fallar en el pedido número `fallarEn`. */
class BuscadorAnotado extends BuscadorCandidatosFijo {
  readonly limites: number[] = [];
  fallarEn: number | null = null;
  override async buscar(origen: unknown, opciones: { limite: number }) {
    this.limites.push(opciones.limite);
    if (this.fallarEn === this.limites.length) throw new ErrorHttp(503, 'UBICACION_NO_DISPONIBLE', 'location no responde');
    return super.buscar(origen, opciones);
  }
}

function conBuscador(choferes: string[], ofertasSimultaneas = 3) {
  const sis = sistemaEnMemoria([], ofertasSimultaneas);
  const buscador = new BuscadorAnotado(choferes);
  // El buscador lo usan los casos de uso por referencia: se reemplaza su lista y su comportamiento.
  Object.assign(sis.buscador, { buscar: buscador.buscar.bind(buscador) });
  return { ...sis, anotado: buscador };
}

describe('la zona del origen', () => {
  it('fuera de toda zona: 422 ORIGEN_FUERA_DE_ZONA, sin solicitud y sin consultar a location', async () => {
    const { casos, elegibilidad, repo, anotado } = conBuscador(uuids(3));
    elegibilidad.fueraDeZona = true;
    await expect(pedir(casos)).rejects.toMatchObject({ codigo: 'ORIGEN_FUERA_DE_ZONA' });
    expect(repo.solicitudes.size).toBe(0);
    expect(repo.eventos).toHaveLength(0);
    expect(anotado.limites).toEqual([]);
  });

  it('la solicitud guarda su zona al crearse', async () => {
    const { casos, repo } = conBuscador(uuids(3));
    const s = await pedir(casos);
    expect(repo.solicitudes.get(s.id)?.zonaId).toBe(ZONA_TEST);
  });
});

describe('lotes crecientes', () => {
  it('los tamaños: desde lo necesario (mínimo 10), duplicando hasta 100', () => {
    expect(lotes(3)).toEqual([10, 20, 40, 80, 100]);
    expect(lotes(50)).toEqual([50, 100]);
    expect(lotes(150)).toEqual([100]);
  });

  it('los 15 más cercanos no sirven: pide un segundo lote y le ofrece al apto que viene después', async () => {
    const noAptos = uuids(15);
    const [apto] = uuids(1) as [string];
    const { casos, elegibilidad, ofertasDe, anotado } = conBuscador([...noAptos, apto]);
    for (const id of noAptos) elegibilidad.noAptos.add(id);
    const s = await pedir(casos);
    expect(anotado.limites).toEqual([10, 20]);
    expect(ofertasDe(s.id).map((o) => o.choferId)).toEqual([apto]);
  });

  it('un lote incompleto corta: no hay más choferes vigentes en el radio', async () => {
    const choferes = uuids(4);
    const { casos, elegibilidad, anotado, metricas } = conBuscador(choferes);
    for (const id of choferes) elegibilidad.noAptos.add(id);
    const s = await pedir(casos);
    expect(anotado.limites).toEqual([10]);
    expect(s.estado).toBe('SIN_CHOFERES');
    expect(metricas.sinAptos).toEqual(['filtrados']);
  });

  it('los 100 más cercanos no sirven (tope agotado): SIN_CHOFERES, como hoy, con su motivo', async () => {
    const choferes = uuids(150);
    const { casos, elegibilidad, anotado, metricas } = conBuscador(choferes);
    for (const id of choferes) elegibilidad.noAptos.add(id);
    const s = await pedir(casos);
    expect(anotado.limites).toEqual([10, 20, 40, 80, 100]);
    expect(s.estado).toBe('SIN_CHOFERES');
    expect(metricas.sinAptos).toEqual(['tope_agotado']);
  });

  it('nadie cerca: un solo pedido, sin_candidatos', async () => {
    const { casos, anotado, metricas } = conBuscador([]);
    expect((await pedir(casos)).estado).toBe('SIN_CHOFERES');
    expect(anotado.limites).toEqual([10]);
    expect(metricas.sinAptos).toEqual(['sin_candidatos']);
  });

  it('si falla el segundo pedido, sube el error de location (503): no se crea nada ni se marca SIN_CHOFERES', async () => {
    const noAptos = uuids(15);
    const { casos, elegibilidad, repo, anotado } = conBuscador([...noAptos, ...uuids(1)]);
    for (const id of noAptos) elegibilidad.noAptos.add(id);
    anotado.fallarEn = 2;
    await expect(pedir(casos)).rejects.toMatchObject({ estado: 503, codigo: 'UBICACION_NO_DISPONIBLE' });
    expect(repo.solicitudes.size).toBe(0);
  });

  it('`completo` sale de la respuesta original: un lote lleno de ya ofrecidos sigue con el próximo', async () => {
    // 3 ya ofrecidos + 7 no aptos llenan el primer lote (10). Recién el 11 es apto.
    const ofrecidos = uuids(3);
    const noAptos = uuids(7);
    const [apto] = uuids(1) as [string];
    const { casos, elegibilidad, reloj, ofertasDe, anotado } = conBuscador([...ofrecidos, ...noAptos, apto]);
    for (const id of noAptos) elegibilidad.noAptos.add(id);
    // La primera tanda: los 3 ofrecidos (el apto quedaría 4º, pero alcanzan 3).
    const s = await pedir(casos);
    expect(ofertasDe(s.id).map((o) => o.choferId)).toEqual(ofrecidos);

    anotado.limites.length = 0;
    reloj.avanzar(TTL_MS + 1);
    await casos.vencerOfertas();
    // Excluidos los 3 ofrecidos y filtrados los 7, del primer lote no queda nadie: como vino lleno, pide más.
    expect(anotado.limites).toEqual([10, 20]);
    expect(ofertasDe(s.id).filter((o) => o.estado === 'PENDIENTE').map((o) => o.choferId)).toEqual([apto]);
  });

  it('el barrido con location caído no marca SIN_CHOFERES: el error sube y la solicitud sigue BUSCANDO', async () => {
    const choferes = uuids(3);
    const { casos, reloj, repo, anotado } = conBuscador(choferes);
    const s = await pedir(casos);
    reloj.avanzar(TTL_MS + 1);
    anotado.fallarEn = anotado.limites.length + 1;
    await expect(casos.vencerOfertas()).rejects.toMatchObject({ estado: 503 });
    expect(repo.solicitudes.get(s.id)?.estado).toBe('BUSCANDO');
  });
});

describe('aceptar: revalidación del chofer', () => {
  it('si dejó de ser apto (inactivo, no disponible o sin la zona): 409 CHOFER_NO_APTO y nada cambia', async () => {
    const choferes = uuids(2);
    const { casos, elegibilidad, ofertasDe, repo } = conBuscador(choferes);
    const s = await pedir(casos);
    const oferta = ofertasDe(s.id)[0]!;
    elegibilidad.noAptosAlAceptar.add(oferta.choferId);
    await expect(casos.aceptarOferta({ ofertaId: oferta.id, choferId: oferta.choferId })).rejects.toMatchObject({
      codigo: 'CHOFER_NO_APTO',
    });
    expect(repo.solicitudes.get(s.id)?.estado).toBe('BUSCANDO');
    expect(ofertasDe(s.id).find((o) => o.id === oferta.id)?.estado).toBe('PENDIENTE');
    expect(repo.asignaciones.size).toBe(0);
  });

  it('al aceptar guarda la flota del chofer en la solicitud', async () => {
    const { casos, ofertasDe, repo } = conBuscador(uuids(1));
    const s = await pedir(casos);
    const oferta = ofertasDe(s.id)[0]!;
    await casos.aceptarOferta({ ofertaId: oferta.id, choferId: oferta.choferId });
    expect(repo.solicitudes.get(s.id)).toMatchObject({ estado: 'ASIGNADO', flotaId: FLOTA_TEST, zonaId: ZONA_TEST });
  });
});

describe('solicitudes de antes de las zonas (zone_id NULL)', () => {
  /** Una solicitud BUSCANDO con una oferta pendiente, guardada como quedó antes de la migración: sin zona. */
  async function vieja(sis: ReturnType<typeof conBuscador>) {
    const s = await pedir(sis.casos);
    const registro = sis.repo.solicitudes.get(s.id)!;
    sis.repo.solicitudes.set(s.id, { ...registro, zonaId: null });
    return s;
  }

  it('aceptar resuelve la zona desde el origen, aplica las reglas nuevas y la guarda', async () => {
    const sis = conBuscador(uuids(1));
    const s = await vieja(sis);
    const oferta = sis.ofertasDe(s.id)[0]!;
    await sis.casos.aceptarOferta({ ofertaId: oferta.id, choferId: oferta.choferId });
    expect(sis.repo.solicitudes.get(s.id)).toMatchObject({ estado: 'ASIGNADO', zonaId: ZONA_TEST, flotaId: FLOTA_TEST });
  });

  it('si su origen quedó fuera de toda zona, nadie puede aceptarla (409 CHOFER_NO_APTO)', async () => {
    const sis = conBuscador(uuids(1));
    const s = await vieja(sis);
    const oferta = sis.ofertasDe(s.id)[0]!;
    sis.elegibilidad.fueraDeZona = true;
    await expect(sis.casos.aceptarOferta({ ofertaId: oferta.id, choferId: oferta.choferId })).rejects.toMatchObject({
      codigo: 'CHOFER_NO_APTO',
    });
    expect(sis.repo.solicitudes.get(s.id)).toMatchObject({ estado: 'BUSCANDO', zonaId: null });
  });

  it('el barrido le busca chofer con las reglas nuevas y le guarda la zona; fuera de zona, SIN_CHOFERES', async () => {
    const choferes = uuids(4);
    const sis = conBuscador(choferes, 2);
    const s = await vieja(sis);
    sis.reloj.avanzar(TTL_MS + 1);
    await sis.casos.vencerOfertas();
    expect(sis.repo.solicitudes.get(s.id)?.zonaId).toBe(ZONA_TEST);
    expect(sis.ofertasDe(s.id).filter((o) => o.estado === 'PENDIENTE').map((o) => o.choferId)).toEqual(choferes.slice(2));

    // Otra vieja, ahora con el origen fuera de toda zona.
    const otra = conBuscador(uuids(4), 2);
    const s2 = await vieja(otra);
    otra.elegibilidad.fueraDeZona = true;
    otra.reloj.avanzar(TTL_MS + 1);
    await otra.casos.vencerOfertas();
    expect(otra.repo.solicitudes.get(s2.id)).toMatchObject({ estado: 'SIN_CHOFERES', zonaId: null });
  });

  it('los viajes históricos (terminados) no se tocan: siguen sin zona ni flota', async () => {
    const sis = conBuscador(uuids(1));
    const s = await pedir(sis.casos);
    const oferta = sis.ofertasDe(s.id)[0]!;
    await sis.casos.aceptarOferta({ ofertaId: oferta.id, choferId: oferta.choferId });
    const registro = sis.repo.solicitudes.get(s.id)!;
    sis.repo.solicitudes.set(s.id, { ...registro, estado: 'COMPLETADA', zonaId: null, flotaId: null });
    sis.reloj.avanzar(TTL_MS + 1);
    await sis.casos.vencerOfertas();
    expect(SolicitudViaje.reconstruir(sis.repo.solicitudes.get(s.id)!).aRegistro()).toMatchObject({ zonaId: null, flotaId: null });
  });
});
