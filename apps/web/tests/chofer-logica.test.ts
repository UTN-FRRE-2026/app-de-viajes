import { describe, expect, it } from 'vitest';
import {
  aplicarEvento,
  aplicarLectura,
  aplicarRespuesta,
  avanceSimulado,
  claveAutomatica,
  ESTADO_INICIAL,
  ofertasVisibles,
  puedeAvanzarSolo,
  restanteMs,
  type EstadoChofer,
} from '../src/roles/chofer/logica';
import type { EstadoChoferRespuesta, OfertaPendiente, Solicitud } from '../src/viaje/viaje';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const T0 = Date.parse('2026-11-23T12:00:00.000Z');

const solicitud = (id: string, estado: Solicitud['estado'], version: number): Solicitud => ({
  id,
  pasajeroId: 'p',
  origen: { lat: -34.6, lng: -58.38 },
  destino: { lat: -34.58, lng: -58.42 },
  estado,
  choferId: 'c',
  motivoCancelacion: null,
  tarifa: null,
  version,
});

const oferta = (id: string, solicitudId: string, venceEn: number): OfertaPendiente => ({
  ofertaId: id,
  solicitudId,
  venceEn: new Date(venceEn).toISOString(),
  origen: { lat: -34.6, lng: -58.38 },
  destino: { lat: -34.58, lng: -58.42 },
  tarifaEstimadaCentavos: 150_000,
});

const lectura = (viaje: Solicitud | null, ofertas: OfertaPendiente[] = [], ahora = T0): EstadoChoferRespuesta => ({
  ahora: new Date(ahora).toISOString(),
  registro: null,
  viaje,
  ofertas,
});

const momento = (inicio: number) => ({ inicio, enviadaEn: T0, recibidaEn: T0 });

describe('lecturas atrasadas', () => {
  it('un GET que empezó antes de aceptar no borra el viaje recién aceptado', () => {
    // El GET sale con la marca 1; aceptar responde con la marca 2; el GET vuelve después, sin viaje.
    const aceptado = aplicarRespuesta({ ...ESTADO_INICIAL, cargado: true, ofertas: [oferta('o1', S1, T0 + 10_000)] }, solicitud(S1, 'ASIGNADO', 1), 2);
    const { estado, descartada } = aplicarLectura(aceptado, lectura(null, [oferta('o1', S1, T0 + 10_000)]), momento(1));
    expect(descartada).toBe(true);
    expect(estado.viaje?.id).toBe(S1);
    expect(estado.ofertas).toEqual([]);
  });

  it('una lectura que empezó después sí refleja que el viaje terminó o cambió', () => {
    const aceptado = aplicarRespuesta({ ...ESTADO_INICIAL, cargado: true }, solicitud(S1, 'ASIGNADO', 1), 2);
    const sinViaje = aplicarLectura(aceptado, lectura(null), momento(3));
    expect(sinViaje.descartada).toBe(false);
    expect(sinViaje.estado.viaje).toBeNull();
    expect(sinViaje.estado.aviso).toMatch(/ya no está activo/);

    // Otro viaje, aunque tenga una versión menor: la versión solo se compara dentro del mismo viaje.
    const otro = aplicarLectura(aceptado, lectura(solicitud(S2, 'ASIGNADO', 0)), momento(3));
    expect(otro.estado.viaje?.id).toBe(S2);
  });

  it('dentro del mismo viaje, una versión vieja no pisa una nueva', () => {
    const enCamino = aplicarRespuesta({ ...ESTADO_INICIAL, cargado: true }, solicitud(S1, 'EN_CAMINO', 2), 5);
    const { estado } = aplicarLectura(enCamino, lectura(solicitud(S1, 'ASIGNADO', 1)), momento(6));
    expect(estado.viaje).toMatchObject({ estado: 'EN_CAMINO', version: 2 });
  });

  it('una respuesta repetida por idempotencia (versión vieja) tampoco pisa el estado nuevo', () => {
    const enCurso: EstadoChofer = { ...ESTADO_INICIAL, cargado: true, viaje: solicitud(S1, 'EN_CURSO', 3) };
    expect(aplicarRespuesta(enCurso, solicitud(S1, 'ASIGNADO', 1), 7).viaje).toMatchObject({ estado: 'EN_CURSO' });
  });
});

describe('aceptación incierta', () => {
  const incierta: EstadoChofer = {
    ...ESTADO_INICIAL,
    cargado: true,
    aceptacion: { oferta: oferta('o1', S1, T0 + 5_000), clave: 'k-1', fase: 'incierta', error: null },
  };

  it('si la relectura todavía no muestra el viaje, se conserva con su clave aunque la oferta ya no esté', () => {
    const { estado } = aplicarLectura(incierta, lectura(null, []), momento(1));
    expect(estado.aceptacion).toMatchObject({ clave: 'k-1', fase: 'incierta' });
    expect(estado.ofertas).toEqual([]);
  });

  it('si la relectura muestra el viaje de esa solicitud, se muestra el viaje y la operación se cierra', () => {
    const { estado } = aplicarLectura(incierta, lectura(solicitud(S1, 'ASIGNADO', 1)), momento(1));
    expect(estado.aceptacion).toBeNull();
    expect(estado.viaje?.id).toBe(S1);
  });
});

describe('vencimiento de las ofertas', () => {
  it('cuenta con el reloj del servidor aunque el del navegador esté corrido', () => {
    // El navegador va 60 s adelantado: su Date.now() es T0 + 60 s cuando el servidor dice T0.
    const local = T0 + 60_000;
    const { estado } = aplicarLectura(ESTADO_INICIAL, lectura(null, [oferta('o1', S1, T0 + 10_000)], T0), {
      inicio: 1,
      enviadaEn: local - 100,
      recibidaEn: local + 100,
    });
    expect(estado.desfaseMs).toBe(-60_000);
    const [o] = estado.ofertas;
    expect(restanteMs(o!, local, estado.desfaseMs)).toBe(10_000);
    expect(ofertasVisibles(estado, local + 9_000)).toHaveLength(1);
    // Vencida: se muestra un momento como «Venció» y después sale, sin esperar a OfferExpired.
    expect(ofertasVisibles(estado, local + 11_000)).toHaveLength(1);
    expect(ofertasVisibles(estado, local + 12_500)).toHaveLength(0);
  });

  it('OfferExpired la saca enseguida y pide releer', () => {
    const e: EstadoChofer = { ...ESTADO_INICIAL, ofertas: [oferta('o1', S1, T0 + 10_000), oferta('o2', S2, T0 + 10_000)] };
    const r = aplicarEvento(e, 'OfferExpired', { ofertaId: 'o1', solicitudId: S1, choferId: 'c' });
    expect(r.estado.ofertas.map((o) => o.ofertaId)).toEqual(['o2']);
    expect(r.releer).toBe(true);
  });

  it('la oferta que se está aceptando no se lista aparte', () => {
    const e: EstadoChofer = {
      ...ESTADO_INICIAL,
      ofertas: [oferta('o1', S1, T0 + 10_000)],
      aceptacion: { oferta: oferta('o1', S1, T0 + 10_000), clave: 'k', fase: 'enviando', error: null },
    };
    expect(ofertasVisibles(e, T0)).toEqual([]);
  });
});

describe('eventos', () => {
  const conViaje: EstadoChofer = { ...ESTADO_INICIAL, viaje: solicitud(S1, 'EN_CURSO', 3) };
  const posicion = (solicitudId: string, segundo: number) => ({
    solicitudId,
    pasajeroId: 'p',
    lat: -34.6,
    lng: -58.38,
    actualizadaEn: new Date(T0 + segundo * 1000).toISOString(),
  });

  it('la posición del pasajero se aplica solo si es del viaje activo y más nueva', () => {
    const a = aplicarEvento(conViaje, 'PassengerLocationUpdated', posicion(S1, 2)).estado;
    expect(a.posicionPasajero?.actualizadaEn).toBe(posicion(S1, 2).actualizadaEn);
    expect(aplicarEvento(a, 'PassengerLocationUpdated', posicion(S1, 1)).estado.posicionPasajero).toBe(a.posicionPasajero);
    expect(aplicarEvento(a, 'PassengerLocationUpdated', posicion(S2, 3)).estado.posicionPasajero).toBe(a.posicionPasajero);
    expect(aplicarEvento(a, 'PassengerLocationUpdated', posicion(S1, 3)).releer).toBe(false);
  });

  it('si el pasajero cancela, avisa con el motivo y relee', () => {
    const r = aplicarEvento(conViaje, 'RideCancelled', {
      solicitudId: S1,
      pasajeroId: 'p',
      choferId: 'c',
      estabaAsignada: true,
      canceladoPor: 'pasajero',
      motivo: 'cambié de planes',
    });
    expect(r.estado.aviso).toBe('El pasajero canceló el viaje: cambié de planes');
    expect(r.releer).toBe(true);
  });

  it('finalizar deja el resumen con la tarifa y sin viaje', () => {
    const e = aplicarRespuesta(conViaje, { ...solicitud(S1, 'COMPLETADA', 4) }, 9);
    expect(e.viaje).toBeNull();
    expect(e.terminado?.id).toBe(S1);
  });
});

describe('avances automáticos de la conducción simulada', () => {
  const asignado: EstadoChofer = { ...ESTADO_INICIAL, cargado: true, viaje: solicitud(S1, 'ASIGNADO', 1) };

  it('«Voy en camino» apenas queda asignado; «Inició el viaje» nunca solo', () => {
    expect(avanceSimulado(solicitud(S1, 'ASIGNADO', 1), { llego: false, finalEnviado: false })).toBe('en-camino');
    expect(avanceSimulado(solicitud(S1, 'EN_CAMINO', 2), { llego: true, finalEnviado: true })).toBeNull();
    expect(avanceSimulado(null, { llego: true, finalEnviado: true })).toBeNull();
  });

  it('«Finalizar» solo al llegar al destino y después de que location tiene el punto final', () => {
    const enCurso = solicitud(S1, 'EN_CURSO', 3);
    expect(avanceSimulado(enCurso, { llego: false, finalEnviado: false })).toBeNull();
    expect(avanceSimulado(enCurso, { llego: true, finalEnviado: false })).toBeNull();
    expect(avanceSimulado(enCurso, { llego: true, finalEnviado: true })).toBe('finalizar');
  });

  it('cada avance se pide una sola vez por viaje y acción', () => {
    expect(puedeAvanzarSolo(asignado, 'en-camino')).toBe(true);
    const pedido = { ...asignado, automaticos: [claveAutomatica(S1, 'en-camino')] };
    expect(puedeAvanzarSolo(pedido, 'en-camino')).toBe(false);
    // Otro viaje, la misma acción: sí.
    expect(puedeAvanzarSolo({ ...pedido, viaje: solicitud(S2, 'ASIGNADO', 1) }, 'en-camino')).toBe(true);
  });

  it('no con otra operación en curso o incierta (no se reintenta en loop: queda «Reintentar»)', () => {
    const incierta: EstadoChofer = {
      ...asignado,
      operacion: { accion: 'en-camino', solicitudId: S1, desde: 'ASIGNADO', clave: 'k', fase: 'incierta', error: new Error('red') },
    };
    expect(puedeAvanzarSolo(incierta, 'en-camino')).toBe(false);
  });

  it('solo la acción que sigue en el estado del viaje', () => {
    expect(puedeAvanzarSolo(asignado, 'finalizar')).toBe(false);
    expect(puedeAvanzarSolo({ ...ESTADO_INICIAL, viaje: null }, 'en-camino')).toBe(false);
  });

  it('las lecturas conservan lo ya pedido', () => {
    const pedido = { ...asignado, automaticos: [claveAutomatica(S1, 'en-camino')] };
    const { estado } = aplicarLectura(pedido, lectura(solicitud(S1, 'EN_CAMINO', 2)), momento(1));
    expect(estado.automaticos).toEqual([claveAutomatica(S1, 'en-camino')]);
  });
});
