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
    const r = await casos.cancelarSolicitud({ solicitudId: s.id, usuarioId: PASAJERO, quien: 'pasajero' });
    expect(r.estado).toBe('CANCELADO_PASAJERO');
    expect(ofertasDe(s.id).every((o) => o.estado === 'CANCELADA')).toBe(true);
  });

  it('cancelar una asignada libera al chofer, que puede tomar otro viaje', async () => {
    const [chofer] = uuids(1) as [string];
    const { casos, ofertasDe, repo } = sistemaEnMemoria([chofer]);
    const s1 = await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    await casos.aceptarOferta({ ofertaId: ofertasDe(s1.id)[0]!.id, choferId: chofer });

    await casos.cancelarSolicitud({ solicitudId: s1.id, usuarioId: PASAJERO, quien: 'pasajero' });
    expect(repo.asignaciones.size).toBe(0);
    expect(repo.eventos.at(-1)).toMatchObject({
      tipo: 'RideCancelled',
      payload: { estabaAsignada: true, choferId: chofer, canceladoPor: 'pasajero', motivo: null },
    });

    const s2 = await casos.crearSolicitud({ pasajeroId: OTRO_PASAJERO, origen: ORIGEN, destino: DESTINO });
    await expect(casos.aceptarOferta({ ofertaId: ofertasDe(s2.id)[0]!.id, choferId: chofer })).resolves.toMatchObject({
      estado: 'ASIGNADO',
    });
  });

  it('la solicitud de otro pasajero responde como inexistente', async () => {
    const { casos } = sistemaEnMemoria(uuids(1));
    const s = await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    await expect(casos.cancelarSolicitud({ solicitudId: s.id, usuarioId: OTRO_PASAJERO, quien: 'pasajero' })).rejects.toMatchObject({
      codigo: 'SOLICITUD_NO_ENCONTRADA',
    });
  });

  it('no se puede cancelar dos veces', async () => {
    const { casos } = sistemaEnMemoria(uuids(1));
    const s = await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    await casos.cancelarSolicitud({ solicitudId: s.id, usuarioId: PASAJERO, quien: 'pasajero' });
    await expect(casos.cancelarSolicitud({ solicitudId: s.id, usuarioId: PASAJERO, quien: 'pasajero' })).rejects.toMatchObject({
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

describe('ciclo de vida del viaje', () => {
  /** Solicitud aceptada por el único chofer, y opcionalmente avanzada hasta `hasta`. */
  async function viajeAsignado(hasta: 'ASIGNADO' | 'EN_CAMINO' | 'EN_CURSO' = 'ASIGNADO') {
    const [chofer] = uuids(1) as [string];
    const sis = sistemaEnMemoria([chofer]);
    const s = await sis.casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    await sis.casos.aceptarOferta({ ofertaId: sis.ofertasDe(s.id)[0]!.id, choferId: chofer });
    const entrada = { solicitudId: s.id, choferId: chofer };
    if (hasta !== 'ASIGNADO') await sis.casos.marcarEnCamino(entrada);
    if (hasta === 'EN_CURSO') await sis.casos.iniciarViaje(entrada);
    return { ...sis, s, chofer, entrada };
  }

  it('asignado → en camino → en curso → completada: libera al chofer y el pasajero puede pedir otro', async () => {
    const { casos, repo, s, entrada } = await viajeAsignado();

    expect(await casos.marcarEnCamino(entrada)).toMatchObject({ estado: 'EN_CAMINO' });
    expect(repo.asignaciones.size).toBe(1);
    expect(await casos.iniciarViaje(entrada)).toMatchObject({ estado: 'EN_CURSO' });
    expect(repo.asignaciones.size).toBe(1);
    expect(await casos.finalizarViaje(entrada)).toMatchObject({ estado: 'COMPLETADA' });
    expect(repo.asignaciones.size).toBe(0);

    expect(repo.eventos.map((e) => e.tipo).slice(-3)).toEqual(['DriverEnRoute', 'TripStarted', 'RideCompleted']);
    expect(repo.eventos.at(-1)?.payload).toEqual({ solicitudId: s.id, pasajeroId: PASAJERO, choferId: entrada.choferId });
    await expect(casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO })).resolves.toBeTruthy();
  });

  it('finalizar dos veces: la segunda da 409 y hay un solo RideCompleted', async () => {
    const { casos, repo, entrada } = await viajeAsignado('EN_CURSO');
    await casos.finalizarViaje(entrada);
    await expect(casos.finalizarViaje(entrada)).rejects.toMatchObject({ codigo: 'TRANSICION_INVALIDA', tipo: 'CONFLICTO' });
    expect(repo.eventos.filter((e) => e.tipo === 'RideCompleted')).toHaveLength(1);
  });

  it('finalizaciones simultáneas: una sola gana', async () => {
    const { casos, repo, entrada } = await viajeAsignado('EN_CURSO');
    const resultados = await Promise.allSettled(Array.from({ length: 10 }, () => casos.finalizarViaje(entrada)));
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(repo.eventos.filter((e) => e.tipo === 'RideCompleted')).toHaveLength(1);
  });

  it('saltear un paso (finalizar un viaje que no empezó) → TRANSICION_INVALIDA', async () => {
    const { casos, repo, s, entrada } = await viajeAsignado();
    await expect(casos.finalizarViaje(entrada)).rejects.toMatchObject({ codigo: 'TRANSICION_INVALIDA' });
    expect(repo.solicitudes.get(s.id)?.estado).toBe('ASIGNADO');
    expect(repo.asignaciones.size).toBe(1);
  });

  it.each(['marcarEnCamino', 'iniciarViaje', 'finalizarViaje'] as const)(
    '%s por un chofer que no es el asignado → 404 y no cambia nada',
    async (accion) => {
      const { casos, repo, s } = await viajeAsignado();
      const [otro] = uuids(1) as [string];
      await expect(casos[accion]({ solicitudId: s.id, choferId: otro })).rejects.toMatchObject({
        codigo: 'SOLICITUD_NO_ENCONTRADA',
      });
      expect(repo.solicitudes.get(s.id)?.version).toBe(1);
    },
  );

  it('el chofer cancela en camino: CANCELADO_CHOFER, queda libre y el pasajero puede volver a pedir', async () => {
    const { casos, repo, s, chofer } = await viajeAsignado('EN_CAMINO');
    const r = await casos.cancelarSolicitud({ solicitudId: s.id, usuarioId: chofer, quien: 'chofer' });
    expect(r.estado).toBe('CANCELADO_CHOFER');
    expect(repo.asignaciones.size).toBe(0);
    expect(repo.eventos.at(-1)).toMatchObject({ tipo: 'RideCancelled', payload: { canceladoPor: 'chofer', choferId: chofer } });
    await expect(casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO })).resolves.toBeTruthy();
  });

  it('un chofer no puede cancelar el viaje de otro chofer → 404', async () => {
    const { casos, s } = await viajeAsignado();
    const [otro] = uuids(1) as [string];
    await expect(casos.cancelarSolicitud({ solicitudId: s.id, usuarioId: otro, quien: 'chofer' })).rejects.toMatchObject({
      codigo: 'SOLICITUD_NO_ENCONTRADA',
    });
  });

  it('el pasajero no puede cancelar un viaje en curso', async () => {
    const { casos, s } = await viajeAsignado('EN_CURSO');
    await expect(casos.cancelarSolicitud({ solicitudId: s.id, usuarioId: PASAJERO, quien: 'pasajero' })).rejects.toMatchObject({
      codigo: 'SOLICITUD_NO_CANCELABLE',
    });
  });

  it('el operador cancela un viaje en curso con motivo y libera al chofer', async () => {
    const { casos, repo, s } = await viajeAsignado('EN_CURSO');
    const [operador] = uuids(1) as [string];
    const r = await casos.cancelarSolicitud({ solicitudId: s.id, usuarioId: operador, quien: 'operador', motivo: 'accidente' });
    expect(r).toMatchObject({ estado: 'CANCELADO_OPERADOR', motivoCancelacion: 'accidente' });
    expect(repo.asignaciones.size).toBe(0);
    expect(repo.eventos.at(-1)).toMatchObject({ payload: { canceladoPor: 'operador', motivo: 'accidente' } });
  });

  it('el operador sin motivo → MOTIVO_REQUERIDO y el chofer sigue con el viaje', async () => {
    const { casos, repo, s } = await viajeAsignado('EN_CAMINO');
    const [operador] = uuids(1) as [string];
    await expect(casos.cancelarSolicitud({ solicitudId: s.id, usuarioId: operador, quien: 'operador' })).rejects.toMatchObject({
      codigo: 'MOTIVO_REQUERIDO',
    });
    expect(repo.solicitudes.get(s.id)?.estado).toBe('EN_CAMINO');
    expect(repo.asignaciones.size).toBe(1);
  });

  it('con un viaje en curso, el pasajero no puede pedir otro', async () => {
    const { casos } = await viajeAsignado('EN_CURSO');
    await expect(casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO })).rejects.toMatchObject({
      codigo: 'SOLICITUD_ACTIVA_EXISTENTE',
    });
  });
});

describe('historial y panel del operador', () => {
  /** Un pasajero pide y cancela `n` viajes, uno por segundo (solo puede tener uno activo a la vez). */
  async function viajesCancelados(sis: ReturnType<typeof sistemaEnMemoria>, pasajeroId: string, n: number, motivo?: string) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      sis.reloj.avanzar(1000);
      const s = await sis.casos.crearSolicitud({ pasajeroId, origen: ORIGEN, destino: DESTINO });
      await sis.casos.cancelarSolicitud({ solicitudId: s.id, usuarioId: pasajeroId, quien: 'pasajero', motivo: motivo ?? null });
      ids.push(s.id);
    }
    return ids;
  }

  it('el pasajero ve solo sus viajes, del más nuevo al más viejo, con la fecha', async () => {
    const sis = sistemaEnMemoria(uuids(1));
    const mios = await viajesCancelados(sis, PASAJERO, 3);
    await viajesCancelados(sis, OTRO_PASAJERO, 2);

    const r = await sis.casos.historial({ usuarioId: PASAJERO, como: 'pasajero', limite: 20, desde: 0 });
    expect(r.viajes.map((v) => v.id)).toEqual([...mios].reverse());
    expect(r.viajes[0]?.creadaEn).toBe('2026-10-28T12:00:03.000Z');
    expect(r.siguiente).toBeNull();
  });

  it('pagina: limite 2 sobre 5 viajes da 2, 2 y 1, y `siguiente` indica dónde seguir', async () => {
    const sis = sistemaEnMemoria(uuids(1));
    const ids = (await viajesCancelados(sis, PASAJERO, 5)).reverse();
    const pagina = (desde: number) => sis.casos.historial({ usuarioId: PASAJERO, como: 'pasajero', limite: 2, desde });

    const [p1, p2, p3] = [await pagina(0), await pagina(2), await pagina(4)];
    expect([p1, p2, p3].map((p) => p.viajes.map((v) => v.id))).toEqual([ids.slice(0, 2), ids.slice(2, 4), ids.slice(4)]);
    expect([p1.siguiente, p2.siguiente, p3.siguiente]).toEqual([2, 4, null]);
  });

  it('el chofer ve los viajes que tuvo asignados, no las ofertas que recibió', async () => {
    const [chofer, otroChofer] = uuids(2) as [string, string];
    const { casos, ofertasDe } = sistemaEnMemoria([chofer, otroChofer], 2);
    const tomada = await casos.crearSolicitud({ pasajeroId: PASAJERO, origen: ORIGEN, destino: DESTINO });
    await casos.crearSolicitud({ pasajeroId: OTRO_PASAJERO, origen: ORIGEN, destino: DESTINO });
    await casos.aceptarOferta({ ofertaId: ofertasDe(tomada.id).find((o) => o.choferId === chofer)!.id, choferId: chofer });

    const r = await casos.historial({ usuarioId: chofer, como: 'chofer', limite: 20, desde: 0 });
    expect(r.viajes.map((v) => v.id)).toEqual([tomada.id]);
    expect((await casos.historial({ usuarioId: otroChofer, como: 'chofer', limite: 20, desde: 0 })).viajes).toEqual([]);
  });

  it('el panel muestra por defecto solo los viajes activos; con `estado`, los de ese estado', async () => {
    const sis = sistemaEnMemoria(uuids(1));
    const [cancelado] = await viajesCancelados(sis, PASAJERO, 1);
    const activo = await sis.casos.crearSolicitud({ pasajeroId: OTRO_PASAJERO, origen: ORIGEN, destino: DESTINO });

    const activos = await sis.casos.panelOperador({ limite: 20, desde: 0 });
    expect(activos.viajes.map((v) => v.id)).toEqual([activo.id]);
    const cancelados = await sis.casos.panelOperador({ estado: 'CANCELADO_PASAJERO', limite: 20, desde: 0 });
    expect(cancelados.viajes.map((v) => v.id)).toEqual([cancelado]);
  });

  it('la búsqueda encuentra por motivo (sin distinguir mayúsculas) y por parte del id', async () => {
    const sis = sistemaEnMemoria(uuids(1));
    const [conMotivo] = await viajesCancelados(sis, PASAJERO, 1, 'Dirección equivocada');
    await viajesCancelados(sis, OTRO_PASAJERO, 1, 'otro motivo');
    const buscar = (texto: string) =>
      sis.casos.panelOperador({ estado: 'CANCELADO_PASAJERO', texto, limite: 20, desde: 0 }).then((r) => r.viajes.map((v) => v.id));

    expect(await buscar('DIRECCIÓN')).toEqual([conMotivo]);
    expect(await buscar(conMotivo!.slice(0, 8))).toEqual([conMotivo]);
    expect(await buscar(PASAJERO.slice(-12))).toEqual([conMotivo]);
    expect(await buscar('no existe')).toEqual([]);
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
