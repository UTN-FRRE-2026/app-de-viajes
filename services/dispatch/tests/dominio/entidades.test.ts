import { describe, expect, it } from 'vitest';
import { Oferta, SolicitudViaje, type EstadoSolicitud } from '../../src/dominio/entidades/index.js';
import { DESTINO, ORIGEN } from '../soporte/memoria.js';

const CHOFER = '00000000-0000-4000-8000-000000000001';

function solicitudEn(estado: EstadoSolicitud) {
  return SolicitudViaje.reconstruir({
    id: 's',
    pasajeroId: 'p',
    origen: ORIGEN,
    destino: DESTINO,
    estado,
    choferId: estado === 'ASIGNADO' || estado === 'COMPLETADA' ? CHOFER : null,
    version: 0,
  });
}

describe('SolicitudViaje: transiciones válidas', () => {
  it('BUSCANDO → ASIGNADO guarda el chofer y sube la versión', () => {
    const s = solicitudEn('BUSCANDO');
    s.asignar(CHOFER);
    expect(s.estado).toBe('ASIGNADO');
    expect(s.choferId).toBe(CHOFER);
    expect(s.version).toBe(1);
  });

  it('BUSCANDO → CANCELADO_PASAJERO no libera chofer', () => {
    const s = solicitudEn('BUSCANDO');
    expect(s.cancelarPorPasajero()).toEqual({ estabaAsignada: false, choferLiberado: null });
    expect(s.estado).toBe('CANCELADO_PASAJERO');
  });

  it('ASIGNADO → CANCELADO_PASAJERO devuelve el chofer a liberar', () => {
    const s = solicitudEn('ASIGNADO');
    expect(s.cancelarPorPasajero()).toEqual({ estabaAsignada: true, choferLiberado: CHOFER });
    expect(s.estado).toBe('CANCELADO_PASAJERO');
  });

  it('BUSCANDO → SIN_CHOFERES', () => {
    const s = solicitudEn('BUSCANDO');
    s.marcarSinChoferes();
    expect(s.estado).toBe('SIN_CHOFERES');
  });

  it('ASIGNADO → COMPLETADA', () => {
    const s = solicitudEn('ASIGNADO');
    s.completar();
    expect(s.estado).toBe('COMPLETADA');
  });
});

describe('SolicitudViaje: transiciones inválidas', () => {
  const noBuscando: EstadoSolicitud[] = ['ASIGNADO', 'CANCELADO_PASAJERO', 'SIN_CHOFERES', 'COMPLETADA'];

  it.each(noBuscando)('no se puede asignar desde %s', (estado) => {
    expect(() => solicitudEn(estado).asignar(CHOFER)).toThrow(expect.objectContaining({ codigo: 'SOLICITUD_NO_DISPONIBLE' }));
  });

  it.each(noBuscando)('no se puede marcar sin choferes desde %s', (estado) => {
    expect(() => solicitudEn(estado).marcarSinChoferes()).toThrow(expect.objectContaining({ codigo: 'SOLICITUD_NO_DISPONIBLE' }));
  });

  it.each(['CANCELADO_PASAJERO', 'SIN_CHOFERES', 'COMPLETADA'] as const)('no se puede cancelar desde %s', (estado) => {
    expect(() => solicitudEn(estado).cancelarPorPasajero()).toThrow(expect.objectContaining({ codigo: 'SOLICITUD_NO_CANCELABLE' }));
  });

  it.each(['BUSCANDO', 'CANCELADO_PASAJERO', 'SIN_CHOFERES', 'COMPLETADA'] as const)('no se puede completar desde %s', (estado) => {
    expect(() => solicitudEn(estado).completar()).toThrow(expect.objectContaining({ codigo: 'SOLICITUD_NO_DISPONIBLE' }));
  });
});

describe('Oferta', () => {
  const vence = new Date('2026-10-28T12:00:15Z');
  const antes = new Date('2026-10-28T12:00:14.999Z');

  it('está vigente hasta el instante de vencimiento (exclusivo)', () => {
    const o = Oferta.nueva('o', 's', CHOFER, vence);
    expect(o.estaVigente(antes)).toBe(true);
    expect(o.estaVigente(vence)).toBe(false);
  });

  it('aceptar una oferta vencida falla aunque el barrido no haya pasado', () => {
    const o = Oferta.nueva('o', 's', CHOFER, vence);
    expect(() => o.aceptar(vence)).toThrow(expect.objectContaining({ codigo: 'OFERTA_VENCIDA' }));
    expect(o.estado).toBe('PENDIENTE');
  });

  it('aceptar dos veces falla la segunda', () => {
    const o = Oferta.nueva('o', 's', CHOFER, vence);
    o.aceptar(antes);
    expect(() => o.aceptar(antes)).toThrow(expect.objectContaining({ codigo: 'OFERTA_VENCIDA' }));
  });

  it('vencerSiCorresponde solo actúa sobre pendientes ya vencidas', () => {
    const o = Oferta.nueva('o', 's', CHOFER, vence);
    expect(o.vencerSiCorresponde(antes)).toBe(false);
    expect(o.vencerSiCorresponde(vence)).toBe(true);
    expect(o.estado).toBe('VENCIDA');
    expect(o.vencerSiCorresponde(vence)).toBe(false);
  });

  it('cancelarSiPendiente no toca una oferta aceptada', () => {
    const o = Oferta.nueva('o', 's', CHOFER, vence);
    o.aceptar(antes);
    expect(o.cancelarSiPendiente()).toBe(false);
    expect(o.estado).toBe('ACEPTADA');
  });
});
