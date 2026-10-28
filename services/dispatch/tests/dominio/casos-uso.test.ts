import { describe, expect, it } from 'vitest';
import { DESTINO, ORIGEN, sistemaEnMemoria, TTL_MS, uuids } from '../soporte/memoria.js';

const [PASAJERO, OTRO_PASAJERO] = uuids(2) as [string, string];

describe('crearSolicitud', () => {
  it('crea la solicitud BUSCANDO y una tanda de ofertas', async () => {
    const choferes = uuids(5);
    const { casos, repo, ofertasDe } = sistemaEnMemoria(choferes, 3);
    const s = await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });

    expect(s.estado).toBe('BUSCANDO');
    expect(ofertasDe(s.id).map((o) => o.choferId)).toEqual(choferes.slice(0, 3));
    expect(repo.eventos.map((e) => e.tipo)).toEqual(['RideRequested', 'OfferCreated', 'OfferCreated', 'OfferCreated']);
  });

  it('sin candidatos pasa a SIN_CHOFERES', async () => {
    const { casos, repo } = sistemaEnMemoria([]);
    const s = await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    expect(s.estado).toBe('SIN_CHOFERES');
    expect(repo.eventos.at(-1)?.tipo).toBe('NoDriversFound');
  });

  it('un pasajero no puede tener dos solicitudes activas', async () => {
    const { casos } = sistemaEnMemoria(uuids(1));
    await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    await expect(casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO })).rejects.toMatchObject({
      codigo: 'SOLICITUD_ACTIVA_EXISTENTE',
    });
  });
});

describe('aceptarOferta', () => {
  async function conSolicitud(nChoferes = 3) {
    const choferes = uuids(nChoferes);
    const sis = sistemaEnMemoria(choferes, nChoferes);
    const s = await sis.casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    return { ...sis, s, choferes, ofertas: sis.ofertasDe(s.id) };
  }

  it('asigna, cancela las otras ofertas y registra TripAssigned', async () => {
    const { casos, repo, s, ofertas, ofertasDe } = await conSolicitud();
    const [ganadora] = ofertas;
    const r = await casos.aceptarOferta({ ofertaId: ganadora!.id, choferId: ganadora!.choferId });

    expect(r).toMatchObject({ estado: 'ASIGNADO', choferId: ganadora!.choferId });
    expect(ofertasDe(s.id).map((o) => o.estado).sort()).toEqual(['ACEPTADA', 'CANCELADA', 'CANCELADA']);
    expect(repo.asignaciones.get(ganadora!.choferId)).toBe(s.id);
    expect(repo.eventos.filter((e) => e.tipo === 'TripAssigned')).toHaveLength(1);
  });

  it('la oferta de otro chofer responde como inexistente', async () => {
    const { casos, ofertas } = await conSolicitud();
    await expect(casos.aceptarOferta({ ofertaId: ofertas[0]!.id, choferId: ofertas[1]!.choferId })).rejects.toMatchObject({
      codigo: 'OFERTA_NO_ENCONTRADA',
      tipo: 'NO_ENCONTRADO',
    });
  });

  it('una oferta vencida no se puede aceptar aunque el barrido no haya corrido', async () => {
    const { casos, reloj, ofertas, repo } = await conSolicitud();
    reloj.avanzar(TTL_MS);
    await expect(casos.aceptarOferta({ ofertaId: ofertas[0]!.id, choferId: ofertas[0]!.choferId })).rejects.toMatchObject({
      codigo: 'OFERTA_VENCIDA',
    });
    expect(repo.asignaciones.size).toBe(0);
  });

  it('si otro chofer ya ganó, responde SOLICITUD_NO_DISPONIBLE', async () => {
    const { casos, ofertas } = await conSolicitud();
    await casos.aceptarOferta({ ofertaId: ofertas[0]!.id, choferId: ofertas[0]!.choferId });
    await expect(casos.aceptarOferta({ ofertaId: ofertas[1]!.id, choferId: ofertas[1]!.choferId })).rejects.toMatchObject({
      codigo: 'SOLICITUD_NO_DISPONIBLE',
    });
  });

  it('aceptaciones simultáneas sobre la misma solicitud: gana exactamente una', async () => {
    const { casos, ofertas, repo } = await conSolicitud(20);
    const resultados = await Promise.allSettled(
      ofertas.map((o) => casos.aceptarOferta({ ofertaId: o.id, choferId: o.choferId })),
    );
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(repo.asignaciones.size).toBe(1);
  });

  it('un chofer con viaje activo no puede aceptar otra solicitud', async () => {
    const [chofer] = uuids(1) as [string];
    const { casos, ofertasDe } = sistemaEnMemoria([chofer]);
    const s1 = await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    const s2 = await casos.crearSolicitud({ pasajeroId: OTRO_PASAJERO, origen: ORIGEN, destino: DESTINO });
    await casos.aceptarOferta({ ofertaId: ofertasDe(s1.id)[0]!.id, choferId: chofer });
    await expect(casos.aceptarOferta({ ofertaId: ofertasDe(s2.id)[0]!.id, choferId: chofer })).rejects.toMatchObject({
      codigo: 'CHOFER_CON_VIAJE_ACTIVO',
    });
  });

  it('un rechazo no deja cambios a medias (la solicitud sigue BUSCANDO)', async () => {
    const [chofer] = uuids(1) as [string];
    const { casos, ofertasDe, repo } = sistemaEnMemoria([chofer]);
    const s1 = await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    const s2 = await casos.crearSolicitud({ pasajeroId: OTRO_PASAJERO, origen: ORIGEN, destino: DESTINO });
    await casos.aceptarOferta({ ofertaId: ofertasDe(s1.id)[0]!.id, choferId: chofer });
    await casos.aceptarOferta({ ofertaId: ofertasDe(s2.id)[0]!.id, choferId: chofer }).catch(() => {});
    expect(repo.solicitudes.get(s2.id)?.estado).toBe('BUSCANDO');
    expect(ofertasDe(s2.id)[0]?.estado).toBe('PENDIENTE');
  });
});

describe('cancelarSolicitud', () => {
  it('cancelar mientras busca cancela las ofertas pendientes', async () => {
    const { casos, ofertasDe } = sistemaEnMemoria(uuids(3));
    const s = await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    const r = await casos.cancelarSolicitud({ solicitudId: s.id, pasajeroId: PASAJERO });
    expect(r.estado).toBe('CANCELADO_PASAJERO');
    expect(ofertasDe(s.id).every((o) => o.estado === 'CANCELADA')).toBe(true);
  });

  it('cancelar una asignada libera al chofer, que puede tomar otro viaje', async () => {
    const [chofer] = uuids(1) as [string];
    const { casos, ofertasDe, repo } = sistemaEnMemoria([chofer]);
    const s1 = await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    await casos.aceptarOferta({ ofertaId: ofertasDe(s1.id)[0]!.id, choferId: chofer });

    await casos.cancelarSolicitud({ solicitudId: s1.id, pasajeroId: PASAJERO });
    expect(repo.asignaciones.size).toBe(0);
    expect(repo.eventos.at(-1)).toMatchObject({ tipo: 'RideCancelled', payload: { estabaAsignada: true, choferId: chofer } });

    const s2 = await casos.crearSolicitud({ pasajeroId: OTRO_PASAJERO, origen: ORIGEN, destino: DESTINO });
    await expect(casos.aceptarOferta({ ofertaId: ofertasDe(s2.id)[0]!.id, choferId: chofer })).resolves.toMatchObject({
      estado: 'ASIGNADO',
    });
  });

  it('la solicitud de otro pasajero responde como inexistente', async () => {
    const { casos } = sistemaEnMemoria(uuids(1));
    const s = await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    await expect(casos.cancelarSolicitud({ solicitudId: s.id, pasajeroId: OTRO_PASAJERO })).rejects.toMatchObject({
      codigo: 'SOLICITUD_NO_ENCONTRADA',
    });
  });

  it('no se puede cancelar dos veces', async () => {
    const { casos } = sistemaEnMemoria(uuids(1));
    const s = await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    await casos.cancelarSolicitud({ solicitudId: s.id, pasajeroId: PASAJERO });
    await expect(casos.cancelarSolicitud({ solicitudId: s.id, pasajeroId: PASAJERO })).rejects.toMatchObject({
      codigo: 'SOLICITUD_NO_CANCELABLE',
    });
  });
});

describe('vencerOfertas (barrido)', () => {
  it('al vencer la tanda, ofrece a los siguientes candidatos', async () => {
    const choferes = uuids(4);
    const { casos, reloj, ofertasDe, repo } = sistemaEnMemoria(choferes, 2);
    const s = await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });

    reloj.avanzar(TTL_MS);
    expect(await casos.vencerOfertas()).toBe(1);

    const ofertas = ofertasDe(s.id);
    expect(ofertas.filter((o) => o.estado === 'VENCIDA').map((o) => o.choferId)).toEqual(choferes.slice(0, 2));
    expect(ofertas.filter((o) => o.estado === 'PENDIENTE').map((o) => o.choferId)).toEqual(choferes.slice(2, 4));
    expect(repo.eventos.filter((e) => e.tipo === 'OfferExpired')).toHaveLength(2);
  });

  it('sin más candidatos, la solicitud queda SIN_CHOFERES', async () => {
    const { casos, reloj, repo } = sistemaEnMemoria(uuids(2), 2);
    const s = await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    reloj.avanzar(TTL_MS);
    await casos.vencerOfertas();
    expect(repo.solicitudes.get(s.id)?.estado).toBe('SIN_CHOFERES');
    expect(repo.eventos.at(-1)?.tipo).toBe('NoDriversFound');
  });

  it('antes del vencimiento no hace nada', async () => {
    const { casos, reloj } = sistemaEnMemoria(uuids(2));
    await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    reloj.avanzar(TTL_MS - 1);
    expect(await casos.vencerOfertas()).toBe(0);
  });
});

describe('liberarChofer', () => {
  it('completa la solicitud, libera al chofer y es idempotente', async () => {
    const [chofer] = uuids(1) as [string];
    const { casos, ofertasDe, repo } = sistemaEnMemoria([chofer]);
    const s = await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    await casos.aceptarOferta({ ofertaId: ofertasDe(s.id)[0]!.id, choferId: chofer });

    expect(await casos.liberarChofer({ solicitudId: s.id })).toEqual({ liberado: true });
    expect(await casos.liberarChofer({ solicitudId: s.id })).toEqual({ liberado: false });
    expect(repo.asignaciones.size).toBe(0);
    expect(repo.solicitudes.get(s.id)?.estado).toBe('COMPLETADA');
    expect(repo.eventos.filter((e) => e.tipo === 'RideCompleted')).toHaveLength(1);
  });
});

describe('obtenerSolicitud', () => {
  it('la ven el pasajero dueño y el chofer asignado; nadie más', async () => {
    const [chofer, extranio] = uuids(2) as [string, string];
    const { casos, ofertasDe } = sistemaEnMemoria([chofer]);
    const s = await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    await casos.aceptarOferta({ ofertaId: ofertasDe(s.id)[0]!.id, choferId: chofer });

    await expect(casos.obtenerSolicitud({ solicitudId: s.id, usuarioId: PASAJERO, veTodas: false })).resolves.toBeTruthy();
    await expect(casos.obtenerSolicitud({ solicitudId: s.id, usuarioId: chofer, veTodas: false })).resolves.toBeTruthy();
    await expect(casos.obtenerSolicitud({ solicitudId: s.id, usuarioId: extranio, veTodas: false })).rejects.toMatchObject({
      codigo: 'SOLICITUD_NO_ENCONTRADA',
    });
    await expect(casos.obtenerSolicitud({ solicitudId: s.id, usuarioId: extranio, veTodas: true })).resolves.toBeTruthy();
  });
});
