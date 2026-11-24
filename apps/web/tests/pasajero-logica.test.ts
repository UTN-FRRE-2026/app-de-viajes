import { describe, expect, it } from 'vitest';
import { ErrorApi } from '../src/api/errores';
import { rutaPanel, motivoValido, textoRechazoCancelacion } from '../src/roles/operador/logica';
import {
  aplicarEvento,
  aplicarLectura,
  aplicarRespuesta,
  ESTADO_INICIAL,
  faltaCobro,
  lineaDeTiempo,
  puedeCancelar,
  textoImporte,
  textoRechazoPedido,
  type EstadoPasajero,
  type ViajeResumen,
} from '../src/roles/pasajero/logica';
import { lugarEn, nombrePunto } from '../src/roles/pasajero/lugares';
import type { Solicitud } from '../src/viaje/viaje';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const C1 = '33333333-3333-4333-8333-333333333333';
const T0 = Date.parse('2026-11-24T12:00:00.000Z');

const solicitud = (id: string, estado: Solicitud['estado'], version: number, extra: Partial<Solicitud> = {}): Solicitud => ({
  id,
  pasajeroId: 'p',
  origen: { lat: -34.6037, lng: -58.3816 },
  destino: { lat: -34.5696, lng: -58.4116 },
  estado,
  choferId: estado === 'BUSCANDO' || estado === 'SIN_CHOFERES' ? null : C1,
  motivoCancelacion: null,
  tarifa: null,
  version,
  ...extra,
});

const resumen = (s: Solicitud, creadaEn = T0): ViajeResumen => ({ ...s, creadaEn: new Date(creadaEn).toISOString() });
const con = (viaje: Solicitud | null, extra: Partial<EstadoPasajero> = {}): EstadoPasajero => ({ ...ESTADO_INICIAL, cargado: true, viaje, ...extra });
const estados = (e: EstadoPasajero) => lineaDeTiempo(e).map((i) => `${i.clave}:${i.estado}`);

describe('lectura del historial', () => {
  it('el viaje activo es el que se muestra, con la hora de pedido del servidor', () => {
    const { estado } = aplicarLectura(ESTADO_INICIAL, [resumen(solicitud(S1, 'ASIGNADO', 2))], 1);
    expect(estado.cargado).toBe(true);
    expect(estado.viaje?.id).toBe(S1);
    expect(estado.creadaEn).toBe(new Date(T0).toISOString());
  });

  it('una lectura que empezó antes de la respuesta de una acción se descarta', () => {
    const e = con(solicitud(S1, 'EN_CAMINO', 3), { ultimaMutacion: 5 });
    const r = aplicarLectura(e, [resumen(solicitud(S1, 'ASIGNADO', 2))], 4);
    expect(r.descartada).toBe(true);
    expect(r.estado).toBe(e);
  });

  it('entre dos versiones del mismo viaje se queda con la más nueva', () => {
    const e = con(solicitud(S1, 'EN_CAMINO', 3));
    expect(aplicarLectura(e, [resumen(solicitud(S1, 'ASIGNADO', 2))], 1).estado.viaje?.estado).toBe('EN_CAMINO');
  });

  it('el viaje que terminó queda en pantalla con su estado final; sin viaje en pantalla, no aparece', () => {
    const e = con(solicitud(S1, 'EN_CURSO', 4));
    const terminado = resumen(solicitud(S1, 'COMPLETADA', 5));
    expect(aplicarLectura(e, [terminado], 1).estado.viaje?.estado).toBe('COMPLETADA');
    expect(aplicarLectura(con(null), [terminado], 1).estado.viaje).toBeNull();
  });

  it('otro viaje descarta las horas, la posición y el cobro del anterior', () => {
    const e = con(solicitud(S1, 'COMPLETADA', 5), {
      horas: { asignado: T0 },
      cobro: { id: 'c', solicitudId: S1, montoCentavos: 1, estado: 'APROBADO', motivoRechazo: null },
    });
    const { estado } = aplicarLectura(e, [resumen(solicitud(S2, 'BUSCANDO', 0))], 1);
    expect(estado.viaje?.id).toBe(S2);
    expect(estado.horas).toEqual({});
    expect(estado.cobro).toBeNull();
  });

  it('un pedido incierto se resuelve cuando la lectura muestra el viaje; una cancelación incierta, cuando ya no está activo', () => {
    const pedido = { origen: { lat: 0, lng: 0 }, destino: { lat: 1, lng: 1 }, clave: 'k', fase: 'incierta' as const, error: null };
    expect(aplicarLectura(con(null, { pedido }), [resumen(solicitud(S1, 'BUSCANDO', 0))], 1).estado.pedido).toBeNull();
    const cancelacion = { solicitudId: S1, clave: 'k', fase: 'incierta' as const, error: null };
    const e = con(solicitud(S1, 'ASIGNADO', 2), { cancelacion });
    expect(aplicarLectura(e, [resumen(solicitud(S1, 'ASIGNADO', 2))], 1).estado.cancelacion).not.toBeNull();
    expect(aplicarLectura(e, [resumen(solicitud(S1, 'CANCELADO_PASAJERO', 3))], 1).estado.cancelacion).toBeNull();
  });
});

describe('eventos del SSE', () => {
  it('los del viaje marcan la hora de su paso (una sola vez) y piden releer', () => {
    const e = con(solicitud(S1, 'BUSCANDO', 0));
    const a = aplicarEvento(e, 'TripAssigned', { solicitudId: S1 }, T0 + 7000);
    expect(a.releer).toBe(true);
    expect(a.estado.horas.asignado).toBe(T0 + 7000);
    const b = aplicarEvento(a.estado, 'TripAssigned', { solicitudId: S1 }, T0 + 9000);
    expect(b.estado.horas.asignado).toBe(T0 + 7000);
  });

  it('los de otro viaje no marcan horas, pero piden releer', () => {
    const r = aplicarEvento(con(null), 'TripAssigned', { solicitudId: S2 }, T0);
    expect(r).toEqual({ estado: con(null), releer: true });
  });

  it('la posición del chofer: solo la de este viaje, con chofer, y más nueva que la última', () => {
    const e = con(solicitud(S1, 'EN_CAMINO', 3));
    const pos = (s: number, solicitudId = S1) => ({ solicitudId, choferId: C1, lat: -34.6, lng: -58.38, actualizadaEn: new Date(T0 + s * 1000).toISOString() });
    const a = aplicarEvento(e, 'DriverLocationUpdated', pos(10), T0).estado;
    expect(a.posicionChofer?.actualizadaEn).toBe(pos(10).actualizadaEn);
    expect(aplicarEvento(a, 'DriverLocationUpdated', pos(5), T0).estado.posicionChofer?.actualizadaEn).toBe(pos(10).actualizadaEn);
    expect(aplicarEvento(e, 'DriverLocationUpdated', pos(10, S2), T0).estado.posicionChofer).toBeNull();
    expect(aplicarEvento(con(solicitud(S1, 'BUSCANDO', 0)), 'DriverLocationUpdated', pos(10), T0).estado.posicionChofer).toBeNull();
  });

  it('la cancelación marca la hora del paso final, sin un aviso aparte (quién y por qué los dice la línea)', () => {
    const e = con(solicitud(S1, 'ASIGNADO', 2));
    const d = { solicitudId: S1, pasajeroId: 'p', choferId: C1, estabaAsignada: true, canceladoPor: 'operador', motivo: 'zona cortada' };
    const r = aplicarEvento(e, 'RideCancelled', d, T0 + 5000);
    expect(r.releer).toBe(true);
    expect(r.estado.aviso).toBeNull();
    const cancelado = { ...r.estado, viaje: solicitud(S1, 'CANCELADO_OPERADOR', 3, { motivoCancelacion: 'zona cortada' }) };
    expect(lineaDeTiempo(cancelado).at(-1)).toMatchObject({ titulo: 'Un operador canceló', hora: T0 + 5000, detalle: 'zona cortada' });
  });

  it('el cobro aprobado o rechazado se aplica directo', () => {
    const e = con(solicitud(S1, 'COMPLETADA', 5));
    const pago = { cobroId: 'c', solicitudId: S1, pasajeroId: 'p', montoCentavos: 487_000, moneda: 'ARS', referencia: 'r' };
    const ok = aplicarEvento(e, 'PaymentCaptured', pago, T0).estado;
    expect(ok.cobro?.estado).toBe('APROBADO');
    expect(ok.horas.cobrado).toBe(T0);
    const no = aplicarEvento(e, 'PaymentDeclined', { ...pago, motivo: 'sin fondos' }, T0).estado;
    expect(no.cobro).toMatchObject({ estado: 'RECHAZADO', motivoRechazo: 'sin fondos' });
  });
});

describe('línea de tiempo', () => {
  it('sigue el estado del viaje: lo anterior hecho, el actual resaltado, lo que sigue pendiente', () => {
    expect(estados(con(solicitud(S1, 'BUSCANDO', 0)))).toEqual([
      'pedido:actual',
      'asignado:pendiente',
      'en-camino:pendiente',
      'en-viaje:pendiente',
      'terminado:pendiente',
      'cobrado:pendiente',
    ]);
    expect(estados(con(solicitud(S1, 'EN_CAMINO', 3)))).toEqual([
      'pedido:hecho',
      'asignado:hecho',
      'en-camino:actual',
      'en-viaje:pendiente',
      'terminado:pendiente',
      'cobrado:pendiente',
    ]);
  });

  it('terminado: el cobro queda en curso hasta que llega, y en rojo si se rechaza', () => {
    const e = con(solicitud(S1, 'COMPLETADA', 5));
    expect(estados(e).slice(-2)).toEqual(['terminado:hecho', 'cobrado:actual']);
    const rechazo = { id: 'c', solicitudId: S1, montoCentavos: 1, estado: 'RECHAZADO' as const, motivoRechazo: 'sin fondos' };
    const linea = lineaDeTiempo({ ...e, cobro: rechazo });
    expect(linea.at(-1)).toMatchObject({ estado: 'fallo', detalle: 'Rechazado: sin fondos' });
  });

  it('cancelado: los pasos que alcanzó y uno final en rojo con el motivo', () => {
    const e = con(solicitud(S1, 'CANCELADO_OPERADOR', 4, { motivoCancelacion: 'zona cortada' }), { horas: { 'en-camino': T0 } });
    expect(estados(e)).toEqual(['pedido:hecho', 'asignado:hecho', 'en-camino:hecho', 'final:fallo']);
    expect(lineaDeTiempo(e).at(-1)).toMatchObject({ titulo: 'Un operador canceló', detalle: 'zona cortada' });
    expect(estados(con(solicitud(S1, 'SIN_CHOFERES', 1)))).toEqual(['pedido:hecho', 'final:fallo']);
  });

  it('las horas: el pedido sale del servidor; la asignación dice cuánto tardó', () => {
    const e = con(solicitud(S1, 'ASIGNADO', 2), { creadaEn: new Date(T0).toISOString(), horas: { asignado: T0 + 7400 } });
    const [pedido, asignado, enCamino] = lineaDeTiempo(e);
    expect(pedido!.hora).toBe(T0);
    expect(asignado).toMatchObject({ hora: T0 + 7400, detalle: 'en 7 s' });
    expect(enCamino!.hora).toBeNull();
  });

  it('la respuesta de pedir marca la hora del pedido y la marca de la acción', () => {
    const e = aplicarRespuesta(con(null), solicitud(S1, 'BUSCANDO', 0), 9, T0);
    expect(e.viaje?.id).toBe(S1);
    expect(e.horas.pedido).toBe(T0);
    expect(e.ultimaMutacion).toBe(9);
  });
});

describe('lo que puede hacer el pasajero', () => {
  it('cancela buscando, asignado o con el chofer en camino; ya en viaje, no (como dispatch)', () => {
    expect(['BUSCANDO', 'ASIGNADO', 'EN_CAMINO', 'EN_CURSO', 'COMPLETADA'].map((s) => puedeCancelar(solicitud(S1, s as Solicitud['estado'], 1)))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('el cobro se lee si el viaje terminó y no se resolvió (el evento pudo llegar con el stream cortado)', () => {
    const terminado = con(solicitud(S1, 'COMPLETADA', 5));
    const cobro = (estado: 'PENDIENTE' | 'APROBADO' | 'RECHAZADO') => ({ id: 'c', solicitudId: S1, montoCentavos: 1, estado, motivoRechazo: null });
    expect(faltaCobro(terminado)).toBe(true);
    expect(faltaCobro({ ...terminado, cobro: cobro('PENDIENTE') })).toBe(true);
    expect(faltaCobro({ ...terminado, cobro: cobro('APROBADO') })).toBe(false);
    expect(faltaCobro({ ...terminado, cobro: cobro('RECHAZADO') })).toBe(false);
    expect(faltaCobro(con(solicitud(S1, 'EN_CURSO', 4)))).toBe(false);
  });
});

describe('textos y lugares', () => {
  it('los rechazos conocidos al pedir tienen su texto', () => {
    expect(textoRechazoPedido(new ErrorApi(409, 'SOLICITUD_ACTIVA_EXISTENTE', 'x'))).toBe('Ya tenés un viaje en curso.');
    expect(textoRechazoPedido(new ErrorApi(422, 'ORIGEN_FUERA_DE_ZONA', 'x'))).toMatch(/zona/);
    expect(textoRechazoPedido(new ErrorApi(500, 'INTERNO', 'x'))).toBeNull();
  });

  it('un punto a menos de 60 m de un lugar de la demo se nombra; si no, es un punto en el mapa', () => {
    expect(lugarEn({ lat: -34.6039, lng: -58.3817 })).toBe('Obelisco');
    expect(nombrePunto({ lat: -34.62, lng: -58.45 })).toBe('Punto en el mapa');
  });

  it('un viaje cancelado no tiene importe; uno sin terminar, el estimado; uno terminado, el final', () => {
    const tarifa = { version: 'v1', moneda: 'ARS' as const, estimadaCentavos: 487_000, recorridoEstimado: { metros: 6200, segundos: 840 }, finalCentavos: null, recorridoFinal: null, motivosDiferencia: [] };
    expect(textoImporte(solicitud(S1, 'CANCELADO_OPERADOR', 3, { tarifa }))).toBe('Sin cargo');
    expect(textoImporte(solicitud(S1, 'EN_CURSO', 3, { tarifa }))).toMatch(/\(estimada\)$/);
    expect(textoImporte(solicitud(S1, 'COMPLETADA', 4, { tarifa: { ...tarifa, finalCentavos: 512_000 } }))).not.toMatch(/estimada/);
  });
});

describe('panel del operador', () => {
  it('la ruta del panel: sin estado, los activos; con texto, la búsqueda recortada', () => {
    expect(rutaPanel({ estado: null, texto: '  ' })).toBe('/viajes/panel/viajes?limite=20&desde=0');
    expect(rutaPanel({ estado: 'COMPLETADA', texto: ' abc ' }, 20)).toBe('/viajes/panel/viajes?limite=20&desde=20&estado=COMPLETADA&q=abc');
  });

  it('el motivo tiene que tener de 3 a 200 caracteres', () => {
    expect(motivoValido('  ab ')).toBe(false);
    expect(motivoValido('abc')).toBe(true);
    expect(motivoValido('x'.repeat(201))).toBe(false);
  });

  it('los rechazos conocidos al cancelar tienen su texto', () => {
    expect(textoRechazoCancelacion(new ErrorApi(409, 'SOLICITUD_NO_CANCELABLE', 'x'))).toMatch(/ya no se puede cancelar/);
    expect(textoRechazoCancelacion(new ErrorApi(0, 'RED', 'x'))).toBeNull();
  });
});
