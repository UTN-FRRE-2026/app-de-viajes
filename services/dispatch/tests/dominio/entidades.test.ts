import { describe, expect, it } from 'vitest';
import { Oferta, SolicitudViaje, type EstadoSolicitud } from '../../src/dominio/entidades/index.js';
import { PARAMETROS_PRUEBA } from '../soporte/mapas-falso.js';
import { DESTINO, ORIGEN } from '../soporte/memoria.js';

const CHOFER = '00000000-0000-4000-8000-000000000001';

const ESTADOS: EstadoSolicitud[] = [
  'BUSCANDO',
  'ASIGNADO',
  'EN_CAMINO',
  'EN_CURSO',
  'COMPLETADA',
  'CANCELADO_PASAJERO',
  'CANCELADO_CHOFER',
  'CANCELADO_OPERADOR',
  'SIN_CHOFERES',
];
const CON_CHOFER = new Set<EstadoSolicitud>(['ASIGNADO', 'EN_CAMINO', 'EN_CURSO', 'COMPLETADA', 'CANCELADO_CHOFER']);
const AHORA = new Date('2026-10-28T12:30:00Z');

function solicitudEn(estado: EstadoSolicitud) {
  return SolicitudViaje.reconstruir({
    id: 's',
    pasajeroId: 'p',
    origen: ORIGEN,
    destino: DESTINO,
    estado,
    choferId: CON_CHOFER.has(estado) ? CHOFER : null,
    motivoCancelacion: estado === 'CANCELADO_OPERADOR' ? 'motivo previo' : null,
    tarifa: {
      version: PARAMETROS_PRUEBA.version,
      moneda: 'ARS',
      estimadaCentavos: 400_000,
      recorridoEstimado: { metros: 5000, segundos: 600 },
      finalCentavos: null,
      recorridoFinal: null,
      motivosDiferencia: [],
    },
    version: 0,
    creadaEn: new Date('2026-10-28T12:00:00Z'),
    iniciadoEn: estado === 'EN_CURSO' ? new Date('2026-10-28T12:20:00Z') : null,
  });
}

/**
 * Cada acción, desde qué estado es válida, a qué estado lleva y qué error da desde los demás.
 * La matriz de abajo prueba las 9 × 8 combinaciones: una por transición válida y una por inválida.
 */
const ACCIONES: Record<
  string,
  { hacer: (s: SolicitudViaje) => unknown; validas: Partial<Record<EstadoSolicitud, EstadoSolicitud>>; error: string }
> = {
  asignar: { hacer: (s) => s.asignar(CHOFER), validas: { BUSCANDO: 'ASIGNADO' }, error: 'SOLICITUD_NO_DISPONIBLE' },
  'marcar sin choferes': {
    hacer: (s) => s.marcarSinChoferes(),
    validas: { BUSCANDO: 'SIN_CHOFERES' },
    error: 'SOLICITUD_NO_DISPONIBLE',
  },
  'marcar en camino': { hacer: (s) => s.marcarEnCamino(), validas: { ASIGNADO: 'EN_CAMINO' }, error: 'TRANSICION_INVALIDA' },
  iniciar: { hacer: (s) => s.iniciar(AHORA), validas: { EN_CAMINO: 'EN_CURSO' }, error: 'TRANSICION_INVALIDA' },
  finalizar: { hacer: (s) => s.finalizar(AHORA, PARAMETROS_PRUEBA), validas: { EN_CURSO: 'COMPLETADA' }, error: 'TRANSICION_INVALIDA' },
  'cancelar (pasajero)': {
    hacer: (s) => s.cancelar('pasajero'),
    validas: { BUSCANDO: 'CANCELADO_PASAJERO', ASIGNADO: 'CANCELADO_PASAJERO', EN_CAMINO: 'CANCELADO_PASAJERO' },
    error: 'SOLICITUD_NO_CANCELABLE',
  },
  'cancelar (chofer)': {
    hacer: (s) => s.cancelar('chofer'),
    validas: { ASIGNADO: 'CANCELADO_CHOFER', EN_CAMINO: 'CANCELADO_CHOFER' },
    error: 'SOLICITUD_NO_CANCELABLE',
  },
  'cancelar (operador, con motivo)': {
    hacer: (s) => s.cancelar('operador', 'pasajero agresivo'),
    validas: {
      BUSCANDO: 'CANCELADO_OPERADOR',
      ASIGNADO: 'CANCELADO_OPERADOR',
      EN_CAMINO: 'CANCELADO_OPERADOR',
      EN_CURSO: 'CANCELADO_OPERADOR',
    },
    error: 'SOLICITUD_NO_CANCELABLE',
  },
};

const casos = Object.entries(ACCIONES).flatMap(([nombre, accion]) =>
  ESTADOS.map((desde) => ({ nombre, desde, hacia: accion.validas[desde], accion })),
);

describe('SolicitudViaje: transiciones válidas', () => {
  it.each(casos.filter((c) => c.hacia))('$nombre: $desde → $hacia (sube la versión)', ({ desde, hacia, accion }) => {
    const s = solicitudEn(desde);
    accion.hacer(s);
    expect(s.estado).toBe(hacia);
    expect(s.version).toBe(1);
  });
});

describe('SolicitudViaje: transiciones inválidas', () => {
  it.each(casos.filter((c) => !c.hacia))('$nombre desde $desde → error y no cambia nada', ({ desde, accion }) => {
    const s = solicitudEn(desde);
    const antes = s.aDatos();
    expect(() => accion.hacer(s)).toThrow(expect.objectContaining({ codigo: accion.error }));
    expect(s.aDatos()).toEqual(antes);
  });
});

describe('SolicitudViaje: detalles de cada transición', () => {
  it('asignar guarda el chofer', () => {
    const s = solicitudEn('BUSCANDO');
    s.asignar(CHOFER);
    expect(s.choferId).toBe(CHOFER);
  });

  it('cancelar mientras busca no libera a nadie', () => {
    expect(solicitudEn('BUSCANDO').cancelar('pasajero')).toEqual({ estabaAsignada: false, choferLiberado: null });
  });

  it.each(['ASIGNADO', 'EN_CAMINO'] as const)('cancelar desde %s devuelve el chofer a liberar', (estado) => {
    expect(solicitudEn(estado).cancelar('chofer')).toEqual({ estabaAsignada: true, choferLiberado: CHOFER });
  });

  it('el operador cancela un viaje en curso y libera al chofer', () => {
    const s = solicitudEn('EN_CURSO');
    expect(s.cancelar('operador', 'accidente')).toEqual({ estabaAsignada: true, choferLiberado: CHOFER });
    expect(s.motivoCancelacion).toBe('accidente');
  });

  it.each([null, '', '   '])('el operador sin motivo (%j) → MOTIVO_REQUERIDO y no cambia nada', (motivo) => {
    const s = solicitudEn('ASIGNADO');
    expect(() => s.cancelar('operador', motivo)).toThrow(expect.objectContaining({ codigo: 'MOTIVO_REQUERIDO', tipo: 'INVALIDO' }));
    expect(s.estado).toBe('ASIGNADO');
    expect(s.version).toBe(0);
  });

  it('el motivo se guarda sin espacios de más; el del pasajero es opcional', () => {
    const conMotivo = solicitudEn('BUSCANDO');
    conMotivo.cancelar('pasajero', '  me equivoqué de dirección ');
    expect(conMotivo.motivoCancelacion).toBe('me equivoqué de dirección');

    const sinMotivo = solicitudEn('BUSCANDO');
    sinMotivo.cancelar('pasajero');
    expect(sinMotivo.motivoCancelacion).toBeNull();
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
