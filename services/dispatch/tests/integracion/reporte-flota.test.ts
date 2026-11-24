import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { preparadorFlotas } from '../soporte/flotas.js';
import { levantarDispatch } from '../soporte/sistema-postgres.js';

/**
 * `GET /flota/reporte` contra Postgres. Los viajes y los cobros se insertan directo en la base, para
 * fijar estados, fechas de inicio y la flota guardada sin recorrer todo el flujo.
 */
let d: Awaited<ReturnType<typeof levantarDispatch>>;
let preparar: ReturnType<typeof preparadorFlotas>;

beforeAll(async () => {
  d = await levantarDispatch();
  preparar = preparadorFlotas(d.casosFlotas, d.directorio);
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
  await d.limpiarFlotas();
});

/** Noviembre de 2026 en Argentina (UTC-3): [1/11 00:00, 1/12 00:00). */
const INICIO = '2026-11-01T00:00:00-03:00';
const FIN = '2026-12-01T00:00:00-03:00';
const EN_NOV = new Date('2026-11-15T15:00:00-03:00');

type Estado = 'COMPLETADA' | 'EN_CURSO' | 'CANCELADO_OPERADOR';
type EstadoCobro = 'PENDIENTE' | 'APROBADO' | 'RECHAZADO';

interface OpcionesViaje {
  estado?: Estado;
  inicio?: Date;
  /** Con monto, el viaje tiene tarifa (estimada y, si está COMPLETADA, final). Sin monto, no tiene. */
  centavos?: bigint | null;
}

/** Un viaje con la flota guardada al aceptar (o sin flota, como los de antes del #36). */
async function viaje(flotaId: string | null, { estado = 'COMPLETADA', inicio = EN_NOV, centavos = null }: OpcionesViaje = {}) {
  const id = randomUUID();
  const final = centavos !== null && estado === 'COMPLETADA';
  await d.prisma.solicitudViaje.create({
    data: {
      id,
      pasajeroId: randomUUID(),
      estado,
      origenLat: -34.6,
      origenLng: -58.4,
      destinoLat: -34.61,
      destinoLng: -58.41,
      choferId: randomUUID(),
      motivoCancelacion: estado === 'CANCELADO_OPERADOR' ? 'prueba' : null,
      tarifaVersion: centavos !== null ? 'v1' : null,
      estimadaCentavos: centavos,
      estimadaMetros: centavos !== null ? 1000 : null,
      estimadaSegundos: centavos !== null ? 300 : null,
      finalCentavos: final ? centavos : null,
      finalMetros: final ? 1000 : null,
      finalSegundos: final ? 300 : null,
      iniciadoEn: inicio,
      flotaId,
    },
  });
  return id;
}

async function cobro(solicitudId: string, centavos: bigint, estado: EstadoCobro) {
  await d.prisma.cobro.create({
    data: {
      id: randomUUID(),
      solicitudId,
      pasajeroId: randomUUID(),
      montoCentavos: centavos,
      estado,
      referencia: estado === 'PENDIENTE' ? null : `ref-${solicitudId.slice(0, 8)}`,
      motivoRechazo: estado === 'RECHAZADO' ? 'fondos insuficientes' : null,
    },
  });
}

/** Un viaje completado con su cobro en ese estado. */
async function completado(flotaId: string | null, centavos: number | bigint, estadoCobro: EstadoCobro, inicio = EN_NOV) {
  const monto = BigInt(centavos);
  const id = await viaje(flotaId, { centavos: monto, inicio });
  await cobro(id, monto, estadoCobro);
  return id;
}

async function reporte(flotaId: string, inicio = INICIO, fin = FIN) {
  return request(d.url)
    .get('/flota/reporte')
    .query({ inicio, fin })
    .set(await d.authFlota(randomUUID(), flotaId));
}

const cero = { cantidad: 0, centavos: 0 };

describe('GET /flota/reporte: aislamiento entre flotas', () => {
  it('cada flota ve solo sus viajes y sus cobros, aunque compartan el período', async () => {
    const [a, b] = [await preparar.flota(5), await preparar.flota(5)];
    await completado(a.id, 10_000, 'APROBADO');
    await completado(a.id, 2_500, 'APROBADO');
    await completado(b.id, 99_900, 'APROBADO');
    await completado(b.id, 700, 'PENDIENTE');

    const ra = await reporte(a.id);
    expect(ra.status).toBe(200);
    expect(ra.headers['cache-control']).toBe('no-store');
    expect(ra.body).toEqual({
      flotaId: a.id,
      inicio: new Date(INICIO).toISOString(),
      fin: new Date(FIN).toISOString(),
      moneda: 'ARS',
      viajesCompletados: 2,
      facturadoCentavos: 12_500,
      cobros: { aprobados: { cantidad: 2, centavos: 12_500 }, pendientes: cero, rechazados: cero },
    });

    const rb = await reporte(b.id);
    expect(rb.body).toMatchObject({
      flotaId: b.id,
      viajesCompletados: 2,
      facturadoCentavos: 99_900,
      cobros: { aprobados: { cantidad: 1, centavos: 99_900 }, pendientes: { cantidad: 1, centavos: 700 }, rechazados: cero },
    });
  });

  it('la flota sale del token: con el de A no hay forma de pedir el reporte de B', async () => {
    const [a, b] = [await preparar.flota(5), await preparar.flota(5)];
    await completado(b.id, 5_000, 'APROBADO');
    const conB = await request(d.url)
      .get('/flota/reporte')
      .query({ inicio: INICIO, fin: FIN, fleetId: b.id })
      .set(await d.authFlota(randomUUID(), a.id));
    expect(conB.status).toBe(400);
    expect((await reporte(a.id)).body).toMatchObject({ flotaId: a.id, viajesCompletados: 0, facturadoCentavos: 0 });
  });
});

describe('GET /flota/reporte: qué cuenta', () => {
  it('cobros en distintos estados: solo suman los aprobados; pendientes y rechazados van aparte', async () => {
    const flota = await preparar.flota(5);
    await completado(flota.id, 10_000, 'APROBADO');
    await completado(flota.id, 3_000, 'APROBADO');
    await completado(flota.id, 4_000, 'PENDIENTE');
    await completado(flota.id, 8_000, 'RECHAZADO');
    await completado(flota.id, 1_000, 'RECHAZADO');

    expect((await reporte(flota.id)).body).toMatchObject({
      viajesCompletados: 5,
      facturadoCentavos: 13_000,
      cobros: {
        aprobados: { cantidad: 2, centavos: 13_000 },
        pendientes: { cantidad: 1, centavos: 4_000 },
        rechazados: { cantidad: 2, centavos: 9_000 },
      },
    });
  });

  it('un viaje completado sin cobro cuenta como viaje y suma cero', async () => {
    const flota = await preparar.flota(5);
    await viaje(flota.id); // COMPLETADA sin tarifa: no tiene cobro
    await completado(flota.id, 2_000, 'APROBADO');

    expect((await reporte(flota.id)).body).toMatchObject({
      viajesCompletados: 2,
      facturadoCentavos: 2_000,
      cobros: { aprobados: { cantidad: 1, centavos: 2_000 }, pendientes: cero, rechazados: cero },
    });
  });

  it('un período sin resultados da 200 con todo en cero', async () => {
    const flota = await preparar.flota(5);
    await completado(flota.id, 5_000, 'APROBADO');
    const res = await reporte(flota.id, '2026-10-01T00:00:00-03:00', '2026-11-01T00:00:00-03:00');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      viajesCompletados: 0,
      facturadoCentavos: 0,
      cobros: { aprobados: cero, pendientes: cero, rechazados: cero },
    });
  });

  it('el período es [inicio, fin) sobre el inicio del viaje', async () => {
    const flota = await preparar.flota(5);
    const ms = (iso: string, delta: number) => new Date(new Date(iso).getTime() + delta);
    await completado(flota.id, 100, 'APROBADO', new Date(INICIO));
    await completado(flota.id, 10, 'APROBADO', ms(FIN, -1));
    await completado(flota.id, 1, 'APROBADO', new Date(FIN));
    await completado(flota.id, 1_000, 'APROBADO', ms(INICIO, -1));

    expect((await reporte(flota.id)).body).toMatchObject({ viajesCompletados: 2, facturadoCentavos: 110 });
  });

  it('quedan fuera los viajes sin flota (fleet_id NULL) y los que no están COMPLETADA', async () => {
    const flota = await preparar.flota(5);
    // Un viaje histórico sin flota, aunque su chofer hoy sea de esta flota: no se le atribuye.
    const [choferDeHoy] = await preparar.choferes(flota.id, 1);
    const historico = await completado(null, 50_000, 'APROBADO');
    await d.prisma.solicitudViaje.update({ where: { id: historico }, data: { choferId: choferDeHoy! } });
    await viaje(flota.id, { estado: 'EN_CURSO', centavos: 7_000n });
    await viaje(flota.id, { estado: 'CANCELADO_OPERADOR', centavos: 7_000n });
    await completado(flota.id, 1_500, 'APROBADO');

    expect((await reporte(flota.id)).body).toMatchObject({ viajesCompletados: 1, facturadoCentavos: 1_500 });
  });
});

describe('GET /flota/reporte: los montos no se redondean', () => {
  it('un total grande pero seguro llega exacto', async () => {
    const flota = await preparar.flota(5);
    // La suma, 8 × 10^15 + 8, es menor que 2^53 − 1 y no termina en ceros: un redondeo se notaría.
    await completado(flota.id, 4_000_000_000_000_003n, 'APROBADO');
    await completado(flota.id, 4_000_000_000_000_005n, 'APROBADO');
    expect((await reporte(flota.id)).body).toMatchObject({ facturadoCentavos: 8_000_000_000_000_008 });
  });

  it('un total que no entra en un entero seguro da 500, no un monto redondeado', async () => {
    const flota = await preparar.flota(5);
    // Cada una entra en un entero seguro; las dos juntas suman 2^53 + 2.
    await completado(flota.id, 2n ** 52n + 1n, 'APROBADO');
    await completado(flota.id, 2n ** 52n + 1n, 'APROBADO');
    const res = await reporte(flota.id);
    expect(res.status).toBe(500);
    expect(res.body.facturadoCentavos).toBeUndefined();
  });
});
