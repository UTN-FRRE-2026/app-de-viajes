import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { calcularTarifa } from '../../src/dominio/tarifas/calculo.js';
import { clave, DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';

/** PR 3 de tarifas por HTTP, contra Postgres y Redis reales, con el mapas simulado y pagos falso. */
let d: Awaited<ReturnType<typeof levantarDispatch>>;

beforeAll(async () => {
  d = await levantarDispatch();
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
  // La tarifa vigente que dejó otro archivo puede tener un mínimo enorme; acá se parte de la semilla.
  await d.limpiarTarifas();
  d.pagos.modo = 'aprueba';
  d.pagos.llamadas.length = 0;
  d.pagos.cobrados.clear();
});

const cuerpo = { origen: ORIGEN, destino: DESTINO };
const eventos = (tipo: string) => d.prisma.eventoOutbox.count({ where: { tipo } });

/** Pide un viaje, lo acepta el único chofer y lo lleva hasta `hasta`. */
async function viaje(hasta: 'EN_CURSO' | 'COMPLETADA' = 'COMPLETADA') {
  const pasajero = randomUUID();
  const chofer = randomUUID();
  d.buscador.choferes = [chofer];
  const comoPasajero = await d.auth(pasajero, 'pasajero');
  const comoChofer = await d.auth(chofer, 'chofer');
  const creada = await request(d.url).post('/solicitudes').set(clave()).set(comoPasajero).send(cuerpo);
  expect(creada.status).toBe(201);
  const oferta = await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId: creada.body.id } });
  await request(d.url).post(`/ofertas/${oferta.id}/aceptar`).set(clave()).set(comoChofer).send({}).expect(200);
  const id = creada.body.id as string;
  for (const accion of ['en-camino', 'iniciar']) {
    await request(d.url).post(`/solicitudes/${id}/${accion}`).set(clave()).set(comoChofer).send({}).expect(200);
  }
  let final: request.Response | undefined;
  if (hasta === 'COMPLETADA') {
    final = await request(d.url).post(`/solicitudes/${id}/finalizar`).set(clave()).set(comoChofer).send({});
    expect(final.status).toBe(200);
  }
  return { id, pasajero, chofer, comoPasajero, comoChofer, creada, final };
}

const cobrar = (id: string, auth: Record<string, string>) =>
  request(d.url).post(`/solicitudes/${id}/cobrar`).set(clave()).set(auth).send({});

describe('estimación guardada al crear', () => {
  it('POST /solicitudes devuelve la misma estimación que GET /tarifas/estimacion, con la versión vigente', async () => {
    const { creada, comoPasajero } = await viaje('EN_CURSO');
    const estimacion = await request(d.url)
      .get('/tarifas/estimacion')
      .query({ origenLat: ORIGEN.lat, origenLng: ORIGEN.lng, destinoLat: DESTINO.lat, destinoLng: DESTINO.lng })
      .set(comoPasajero);
    expect(creada.body.tarifa).toEqual({
      version: estimacion.body.tarifaVersion,
      moneda: 'ARS',
      estimadaCentavos: estimacion.body.tarifaCentavos,
      recorridoEstimado: { metros: estimacion.body.distanciaMetros, segundos: estimacion.body.duracionSegundos },
      finalCentavos: null,
      recorridoFinal: null,
      motivosDiferencia: [],
    });
    const fila = await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: creada.body.id } });
    expect(fila).toMatchObject({ tarifaVersion: estimacion.body.tarifaVersion, estimadaCentavos: estimacion.body.tarifaCentavos });
  });

  it('un viaje de más del máximo (Buenos Aires → Córdoba) no se crea: 422 y nada en la base', async () => {
    const res = await request(d.url)
      .post('/solicitudes')
      .set(clave())
      .set(await d.auth(randomUUID(), 'pasajero'))
      .send({ origen: ORIGEN, destino: { lat: -31.4201, lng: -64.1888 } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VIAJE_FUERA_DE_RANGO');
    expect(await d.prisma.solicitudViaje.count()).toBe(0);
  });
});

describe('tarifa final', () => {
  it('finalizar calcula la final con la misma fórmula y versión, guarda por qué difiere y deja el cobro PENDIENTE', async () => {
    const { id, final } = await viaje();
    const tarifa = final!.body.tarifa;
    const parametros = await d.repoTarifas.porVersion(tarifa.version);
    // El viaje real duró milisegundos: 0 s contra los estimados, así que el importe bajó.
    expect(tarifa.recorridoFinal).toEqual({ metros: tarifa.recorridoEstimado.metros, segundos: 0 });
    expect(tarifa.finalCentavos).toBe(calcularTarifa(parametros!, tarifa.recorridoFinal).totalCentavos);
    expect(tarifa.finalCentavos).toBeLessThan(tarifa.estimadaCentavos);
    expect(tarifa.motivosDiferencia).toEqual(['DURACION']);

    const fila = await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id } });
    expect(fila).toMatchObject({ finalCentavos: tarifa.finalCentavos, finalSegundos: 0, motivosDiferencia: ['DURACION'] });
    expect(fila.iniciadoEn).toBeInstanceOf(Date);

    const cobro = await d.prisma.cobro.findUniqueOrThrow({ where: { solicitudId: id } });
    expect(cobro).toMatchObject({ estado: 'PENDIENTE', montoCentavos: tarifa.finalCentavos, intentosFallidos: 0 });
    expect(await eventos('RideCompleted')).toBe(1);
    expect(d.pagos.llamadas).toHaveLength(0);
  });

  it('precio congelado: el admin cambia la tarifa durante el viaje y la final usa la versión de la estimación', async () => {
    const { id, comoChofer, creada } = await viaje('EN_CURSO');
    const admin = await d.auth(randomUUID(), 'admin');
    const nueva = await request(d.url)
      .put('/admin/tarifas')
      .set(clave())
      .set(admin)
      .send({ bajadaCentavos: 9_000_000, centavosPorKm: 9_000_000, centavosPorMinuto: 0, minimoCentavos: 0, maxMetros: 200_000 });
    expect(nueva.status).toBe(200);
    expect(nueva.body.version).not.toBe(creada.body.tarifa.version);

    const final = await request(d.url).post(`/solicitudes/${id}/finalizar`).set(clave()).set(comoChofer).send({});
    expect(final.body.tarifa.version).toBe(creada.body.tarifa.version);
    const parametros = await d.repoTarifas.porVersion(creada.body.tarifa.version);
    expect(final.body.tarifa.finalCentavos).toBe(calcularTarifa(parametros!, final.body.tarifa.recorridoFinal).totalCentavos);
    expect(final.body.tarifa.finalCentavos).toBeLessThan(9_000_000);
  });

  it('el reintento de finalizar con la misma Idempotency-Key no crea otro cobro', async () => {
    const { id, comoChofer } = await viaje('EN_CURSO');
    const encabezados = clave();
    const a = await request(d.url).post(`/solicitudes/${id}/finalizar`).set(encabezados).set(comoChofer).send({});
    const b = await request(d.url).post(`/solicitudes/${id}/finalizar`).set(encabezados).set(comoChofer).send({});
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.text).toBe(a.text);
    expect(await d.prisma.cobro.count({ where: { solicitudId: id } })).toBe(1);
  });
});

describe('cobro', () => {
  it('POST /cobrar aprueba; el detalle del viaje lo muestra; volver a cobrar no llama otra vez al proveedor', async () => {
    const { id, comoPasajero, final } = await viaje();
    const res = await cobrar(id, comoPasajero);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ estado: 'APROBADO', montoCentavos: final!.body.tarifa.finalCentavos, referencia: expect.any(String) });
    expect(d.pagos.llamadas.map((l) => l.clave)).toEqual([res.body.id]);

    const detalle = await request(d.url).get(`/solicitudes/${id}`).set(comoPasajero);
    expect(detalle.body.cobro).toMatchObject({ estado: 'APROBADO', referencia: res.body.referencia });

    const otraVez = await cobrar(id, comoPasajero);
    expect(otraVez.status).toBe(200);
    expect(otraVez.body).toEqual(res.body);
    expect(d.pagos.llamadas).toHaveLength(1);
    expect(await eventos('PaymentCaptured')).toBe(1);
  });

  it('el barrido cobra solo, sin que nadie lo pida', async () => {
    const { id } = await viaje();
    expect(await d.casos.cobrarPendientes()).toBe(1);
    expect(await d.prisma.cobro.findUniqueOrThrow({ where: { solicitudId: id } })).toMatchObject({ estado: 'APROBADO' });
  });

  it('proveedor caído: 503, el cobro sigue PENDIENTE con el intento anotado, y después se cobra una sola vez', async () => {
    const { id, comoPasajero } = await viaje();
    d.pagos.modo = 'falla';
    const res = await cobrar(id, comoPasajero);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PAGOS_NO_DISPONIBLE');
    expect(await d.prisma.cobro.findUniqueOrThrow({ where: { solicitudId: id } })).toMatchObject({
      estado: 'PENDIENTE',
      intentosFallidos: 1,
      referencia: null,
    });
    // El error no se guardó con la Idempotency-Key: no hubo efecto.
    expect(await eventos('PaymentCaptured')).toBe(0);

    d.pagos.modo = 'aprueba';
    expect((await cobrar(id, comoPasajero)).body.estado).toBe('APROBADO');
    expect(d.pagos.cobrados.size).toBe(1);
  });

  it('rechazado: RECHAZADO con motivo y PaymentDeclined', async () => {
    const { id, comoPasajero } = await viaje();
    d.pagos.modo = 'rechaza';
    const res = await cobrar(id, comoPasajero);
    expect(res.body).toMatchObject({ estado: 'RECHAZADO', motivoRechazo: 'tarjeta rechazada' });
    expect(await eventos('PaymentDeclined')).toBe(1);
  });

  it('permisos: otro pasajero 404, el chofer 403, el operador puede; sin Idempotency-Key 400', async () => {
    const { id, comoChofer, comoPasajero } = await viaje();
    expect((await cobrar(id, await d.auth(randomUUID(), 'pasajero'))).status).toBe(404);
    expect((await cobrar(id, comoChofer)).status).toBe(403);
    expect((await request(d.url).post(`/solicitudes/${id}/cobrar`).set(comoPasajero).send({})).status).toBe(400);
    expect((await cobrar(id, await d.auth(randomUUID(), 'operador'))).body.estado).toBe('APROBADO');
  });

  it('un viaje en curso todavía no tiene cobro: 404', async () => {
    const { id, comoPasajero } = await viaje('EN_CURSO');
    const res = await cobrar(id, comoPasajero);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('COBRO_NO_ENCONTRADO');
  });
});

describe('proveedor colgado', () => {
  it('corta por timeout: 503 enseguida y el cobro sigue PENDIENTE', async () => {
    const lento = await levantarDispatch({ extra: { PAGOS_TIMEOUT_MS: '100' } });
    try {
      const pasajero = randomUUID();
      const chofer = randomUUID();
      lento.buscador.choferes = [chofer];
      const comoChofer = await lento.auth(chofer, 'chofer');
      const comoPasajero = await lento.auth(pasajero, 'pasajero');
      const creada = await request(lento.url).post('/solicitudes').set(clave()).set(comoPasajero).send(cuerpo);
      const oferta = await lento.prisma.oferta.findFirstOrThrow({ where: { solicitudId: creada.body.id } });
      await request(lento.url).post(`/ofertas/${oferta.id}/aceptar`).set(clave()).set(comoChofer).send({});
      for (const accion of ['en-camino', 'iniciar', 'finalizar']) {
        await request(lento.url).post(`/solicitudes/${creada.body.id}/${accion}`).set(clave()).set(comoChofer).send({}).expect(200);
      }
      lento.pagos.modo = 'colgado';
      const inicio = Date.now();
      const res = await request(lento.url).post(`/solicitudes/${creada.body.id}/cobrar`).set(clave()).set(comoPasajero).send({});
      expect(res.status).toBe(503);
      expect(Date.now() - inicio).toBeLessThan(2000);
      expect((await lento.prisma.cobro.findUniqueOrThrow({ where: { solicitudId: creada.body.id } })).estado).toBe('PENDIENTE');
    } finally {
      await lento.cerrar();
    }
  });
});

describe('la base lo exige aunque el código se equivoque (CHECK)', () => {
  it('no hay COMPLETADA sin tarifa final, ni cobro aprobado sin referencia, ni dos cobros por viaje', async () => {
    const { id } = await viaje();
    await expect(d.prisma.$executeRaw`UPDATE ride_requests SET final_fare_cents = NULL, final_distance_m = NULL,
      final_duration_s = NULL WHERE id = ${id}::uuid`).rejects.toThrow(/ride_requests_completada_con_tarifa_check/);
    await expect(
      d.prisma.$executeRaw`UPDATE payments SET status = 'APROBADO' WHERE request_id = ${id}::uuid`,
    ).rejects.toThrow(/payments_resuelto_check/);
    await expect(
      d.prisma.$executeRaw`INSERT INTO payments (id, request_id, passenger_id, amount_cents)
        SELECT gen_random_uuid(), request_id, passenger_id, amount_cents FROM payments WHERE request_id = ${id}::uuid`,
    ).rejects.toThrow(/payments_request_id_key/);
  });
});
