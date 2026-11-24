import { describe, expect, it } from 'vitest';
import { crearCasosDeFlotas } from '../../src/dominio/casos-uso/flotas.js';
import { RepositorioFlotasMemoria } from '../../src/infra/memoria/flotas-memoria.js';
import { RepositorioDespachoMemoria } from '../../src/infra/memoria/repositorio-memoria.js';
import { ElegibilidadMemoria, seSuperponen, zonaQueCubre } from '../../src/infra/memoria/zonas-memoria.js';
import { DirectorioFalso } from '../soporte/directorio-falso.js';
import { preparadorFlotas } from '../soporte/flotas.js';

/** La versión en memoria (DISPATCH_PERSISTENCIA=memoria) aplica las mismas reglas que el SQL. */
const rect = (lng1: number, lat1: number, lng2: number, lat2: number): [number, number][] => [
  [lng1, lat1],
  [lng2, lat1],
  [lng2, lat2],
  [lng1, lat2],
  [lng1, lat1],
];
const NORTE = { id: 'a', nombre: 'Norte', anillo: rect(-58.5, -34.6, -58.4, -34.5) };
const SUR = { id: 'b', nombre: 'Sur', anillo: rect(-58.5, -34.7, -58.4, -34.6) };

describe('geometría en memoria', () => {
  it('superposición: tocarse en el borde no cuenta, compartir interior sí', () => {
    expect(seSuperponen(NORTE.anillo, SUR.anillo)).toBe(false);
    expect(seSuperponen(NORTE.anillo, rect(-58.45, -34.58, -58.35, -34.52))).toBe(true);
    expect(seSuperponen(NORTE.anillo, rect(-58.48, -34.58, -58.42, -34.52))).toBe(true); // una adentro de la otra
  });

  it('la zona de un punto: adentro, afuera y en el borde compartido (gana la de menor id)', () => {
    expect(zonaQueCubre([NORTE, SUR], { lat: -34.55, lng: -58.45 })).toBe('a');
    expect(zonaQueCubre([NORTE, SUR], { lat: -34.65, lng: -58.45 })).toBe('b');
    expect(zonaQueCubre([SUR, NORTE], { lat: -34.6, lng: -58.45 })).toBe('a');
    expect(zonaQueCubre([NORTE, SUR], { lat: -34.4, lng: -58.45 })).toBeNull();
  });
});

describe('zonas y elegibilidad en memoria', () => {
  it('superpuesta → 409, inválida → 422; el filtro exige habilitado, activo, disponible, sin viaje y la zona', async () => {
    const flotas = new RepositorioFlotasMemoria();
    const directorio = new DirectorioFalso();
    const casos = crearCasosDeFlotas({ repoFlotas: flotas, directorio });
    await casos.guardarZona(NORTE);
    await expect(casos.guardarZona({ id: 'c', nombre: 'Centro', anillo: rect(-58.45, -34.58, -58.35, -34.52) })).rejects.toMatchObject({
      codigo: 'ZONAS_SUPERPUESTAS',
    });
    const corbata: [number, number][] = [
      [-58.5, -34.5],
      [-58.4, -34.6],
      [-58.5, -34.6],
      [-58.4, -34.5],
      [-58.5, -34.5],
    ];
    await expect(casos.guardarZona({ id: 'd', nombre: 'Corbata', anillo: corbata })).rejects.toMatchObject({ codigo: 'ZONA_INVALIDA' });

    const preparar = preparadorFlotas(casos, directorio);
    const flota = (await preparar.flota(5)).id;
    await casos.zonasDeFlota(flota, ['a']);
    const [apto, inactivo, noDisponible] = await preparar.choferes(flota, 3);
    for (const c of [apto!, noDisponible!]) await casos.activarChofer({ fleetId: flota }, c);
    await casos.cambiarDisponibilidad(apto!, true);

    const despacho = new RepositorioDespachoMemoria();
    const elegibilidad = new ElegibilidadMemoria(flotas, despacho);
    expect(await elegibilidad.zonaDelOrigen({ lat: -34.55, lng: -58.45 })).toBe('a');
    expect(await elegibilidad.aptos([inactivo!, noDisponible!, apto!], 'a')).toEqual([apto]);
    expect(await elegibilidad.choferAptoParaAceptar(apto!, 'a')).toEqual({ flotaId: flota });
    // Con un viaje activo deja de ser candidato; sin la zona, tampoco puede aceptar.
    despacho.asignaciones.set(apto!, 'viaje');
    expect(await elegibilidad.aptos([apto!], 'a')).toEqual([]);
    await casos.zonasDeFlota(flota, []);
    expect(await elegibilidad.choferAptoParaAceptar(apto!, 'a')).toBeNull();
  });
});
