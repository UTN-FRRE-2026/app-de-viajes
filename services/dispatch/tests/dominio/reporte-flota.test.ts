import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { crearCasosDeFlotas } from '../../src/dominio/casos-uso/flotas.js';
import type { DatosCobro, EstadoCobro, RegistroSolicitud } from '../../src/dominio/entidades/index.js';
import { totalCentavos } from '../../src/infra/db/importes.js';
import { RepositorioFlotasMemoria } from '../../src/infra/memoria/flotas-memoria.js';
import { RepositorioDespachoMemoria } from '../../src/infra/memoria/repositorio-memoria.js';
import { DirectorioFalso } from '../soporte/directorio-falso.js';

describe('totalCentavos: el SUM(bigint) de Postgres (numeric) sin redondear', () => {
  it('convierte un total exacto, incluido el máximo entero seguro', () => {
    expect(totalCentavos('0')).toBe(0);
    expect(totalCentavos('1543000')).toBe(1_543_000);
    expect(totalCentavos(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('falla en vez de redondear un total que pasa 2^53', () => {
    // 2^53 + 1 no existe como number: Number('9007199254740993') daría 9007199254740992.
    expect(() => totalCentavos('9007199254740993')).toThrow(RangeError);
    expect(() => totalCentavos(String(Number.MAX_SAFE_INTEGER + 1))).toThrow(RangeError);
  });

  it('rechaza lo que no es un entero no negativo', () => {
    for (const t of ['', '-1', '1.5', '1e3', 'abc']) expect(() => totalCentavos(t), t).toThrow(RangeError);
  });
});

describe('reporte de la flota en memoria (las mismas reglas que en Postgres)', () => {
  const NOV = { inicio: new Date('2026-11-01T03:00:00Z'), fin: new Date('2026-12-01T03:00:00Z') };

  function sistema() {
    const viajes = new RepositorioDespachoMemoria();
    const repoFlotas = new RepositorioFlotasMemoria();
    const casos = crearCasosDeFlotas({ repoFlotas, directorio: new DirectorioFalso(), viajes });
    const viaje = (flotaId: string | null, iniciadoEn: Date, estado: RegistroSolicitud['estado'] = 'COMPLETADA') => {
      const id = randomUUID();
      viajes.solicitudes.set(id, {
        id,
        pasajeroId: randomUUID(),
        origen: { lat: -34.6, lng: -58.4 },
        destino: { lat: -34.61, lng: -58.41 },
        estado,
        choferId: randomUUID(),
        motivoCancelacion: null,
        tarifa: null,
        version: 0,
        creadaEn: iniciadoEn,
        iniciadoEn,
        flotaId,
      });
      return id;
    };
    const cobro = (solicitudId: string, montoCentavos: number, estado: EstadoCobro) => {
      const d: DatosCobro = {
        id: randomUUID(),
        solicitudId,
        pasajeroId: randomUUID(),
        montoCentavos,
        moneda: 'ARS',
        estado,
        intentosFallidos: 0,
        referencia: estado === 'PENDIENTE' ? null : 'ref',
        motivoRechazo: estado === 'RECHAZADO' ? 'sin fondos' : null,
      };
      viajes.cobros.set(solicitudId, d);
    };
    return { casos, viaje, cobro };
  }

  it('cuenta los completados de la flota en [inicio, fin) y factura solo los aprobados', async () => {
    const { casos, viaje, cobro } = sistema();
    const a = await casos.guardarFlota({ id: randomUUID(), nombre: 'A', maxActivos: 5 });
    const b = await casos.guardarFlota({ id: randomUUID(), nombre: 'B', maxActivos: 5 });
    cobro(viaje(a.id, NOV.inicio), 1000, 'APROBADO');
    cobro(viaje(a.id, new Date('2026-11-15T12:00:00Z')), 200, 'PENDIENTE');
    cobro(viaje(a.id, new Date('2026-11-16T12:00:00Z')), 30, 'RECHAZADO');
    viaje(a.id, new Date('2026-11-17T12:00:00Z')); // completado sin cobro
    cobro(viaje(a.id, NOV.fin), 9, 'APROBADO'); // en el borde de fin: afuera
    cobro(viaje(a.id, new Date('2026-11-18T12:00:00Z'), 'EN_CURSO'), 9, 'APROBADO');
    cobro(viaje(null, new Date('2026-11-18T12:00:00Z')), 9, 'APROBADO');
    cobro(viaje(b.id, new Date('2026-11-18T12:00:00Z')), 5000, 'APROBADO');

    expect(await casos.reporte({ fleetId: a.id }, NOV)).toEqual({
      flotaId: a.id,
      inicio: NOV.inicio.toISOString(),
      fin: NOV.fin.toISOString(),
      moneda: 'ARS',
      viajesCompletados: 4,
      facturadoCentavos: 1000,
      cobros: {
        aprobados: { cantidad: 1, centavos: 1000 },
        pendientes: { cantidad: 1, centavos: 200 },
        rechazados: { cantidad: 1, centavos: 30 },
      },
    });
    expect((await casos.reporte({ fleetId: b.id }, NOV)).facturadoCentavos).toBe(5000);
  });

  it('sin fleetId en el token: 403; con una flota que no existe: 404', async () => {
    const { casos } = sistema();
    await expect(casos.reporte({}, NOV)).rejects.toMatchObject({ codigo: 'FLOTA_NO_ASIGNADA' });
    await expect(casos.reporte({ fleetId: randomUUID() }, NOV)).rejects.toMatchObject({ codigo: 'FLOTA_NO_ENCONTRADA' });
  });
});
