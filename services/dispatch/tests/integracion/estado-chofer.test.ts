import { randomUUID } from 'node:crypto';
import { EstadoChoferRespuesta } from '@viajes/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { preparadorFlotas } from '../soporte/flotas.js';
import { clave, DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';

/**
 * `GET /chofer/estado` contra Postgres: lo que la pantalla del chofer relee al abrir, al reconectar y
 * con cada evento. Cada respuesta se valida con el contrato estricto que usa la web.
 */
let d: Awaited<ReturnType<typeof levantarDispatch>>;

beforeAll(async () => {
  d = await levantarDispatch();
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
  await d.limpiarFlotas();
});

async function estado(chofer: string) {
  const res = await request(d.url).get('/chofer/estado').set(await d.auth(chofer, 'chofer'));
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  return EstadoChoferRespuesta.parse(res.body);
}

async function pedir(choferes: string[], pasajero = randomUUID()) {
  d.buscador.choferes = choferes;
  const res = await request(d.url)
    .post('/solicitudes')
    .set(clave())
    .set(await d.auth(pasajero, 'pasajero'))
    .send({ origen: ORIGEN, destino: DESTINO });
  expect(res.status).toBe(201);
  return { solicitudId: res.body.id as string, pasajero };
}

const ofertaDe = (solicitudId: string, chofer: string) =>
  d.prisma.oferta.findFirstOrThrow({ where: { solicitudId, choferId: chofer } });

async function aceptar(solicitudId: string, chofer: string) {
  const oferta = await ofertaDe(solicitudId, chofer);
  return request(d.url).post(`/ofertas/${oferta.id}/aceptar`).set(clave()).set(await d.auth(chofer, 'chofer')).send({});
}

async function accion(solicitudId: string, chofer: string, que: 'en-camino' | 'iniciar' | 'finalizar') {
  await request(d.url).post(`/solicitudes/${solicitudId}/${que}`).set(clave()).set(await d.auth(chofer, 'chofer')).send({}).expect(200);
}

describe('GET /chofer/estado', () => {
  it('sin flota, viaje ni ofertas: todo vacío, con la hora del servidor', async () => {
    const antes = Date.now();
    const e = await estado(randomUUID());
    expect(e).toMatchObject({ registro: null, viaje: null, ofertas: [] });
    expect(Date.parse(e.ahora)).toBeGreaterThanOrEqual(antes - 1000);
  });

  it('cada chofer ve solo su oferta pendiente, con origen, destino y tarifa estimada', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const { solicitudId } = await pedir([a, b]);
    const [ea, eb] = [await estado(a), await estado(b)];
    const [oa, ob] = [await ofertaDe(solicitudId, a), await ofertaDe(solicitudId, b)];

    expect(ea.ofertas).toEqual([
      {
        ofertaId: oa.id,
        solicitudId,
        venceEn: oa.venceEn.toISOString(),
        origen: ORIGEN,
        destino: DESTINO,
        tarifaEstimadaCentavos: expect.any(Number),
      },
    ]);
    expect(eb.ofertas.map((o) => o.ofertaId)).toEqual([ob.id]);
    expect(ea.viaje).toBeNull();
  });

  it('cuando otro chofer gana, la oferta del perdedor desaparece (sin evento que lo avise)', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const { solicitudId } = await pedir([a, b]);
    expect((await aceptar(solicitudId, b)).status).toBe(200);

    expect((await estado(a)).ofertas).toEqual([]);
    const eb = await estado(b);
    expect(eb.ofertas).toEqual([]);
    expect(eb.viaje).toMatchObject({ id: solicitudId, estado: 'ASIGNADO', choferId: b });
  });

  it('no muestra una oferta vencida, aunque el barrido todavía no la haya marcado', async () => {
    const a = randomUUID();
    const { solicitudId } = await pedir([a]);
    await d.prisma.oferta.updateMany({ where: { solicitudId }, data: { venceEn: new Date(Date.now() - 1000) } });
    expect(await d.prisma.oferta.count({ where: { solicitudId, estado: 'PENDIENTE' } })).toBe(1);
    expect((await estado(a)).ofertas).toEqual([]);
  });

  it('si el pasajero cancela, la oferta desaparece', async () => {
    const a = randomUUID();
    const { solicitudId, pasajero } = await pedir([a]);
    await request(d.url).post(`/solicitudes/${solicitudId}/cancelar`).set(clave()).set(await d.auth(pasajero, 'pasajero')).send({}).expect(200);
    expect((await estado(a)).ofertas).toEqual([]);
  });

  it('el viaje activo se ve en ASIGNADO, EN_CAMINO y EN_CURSO, y deja de verse al finalizar', async () => {
    const a = randomUUID();
    const { solicitudId } = await pedir([a]);
    await aceptar(solicitudId, a);
    const versiones: number[] = [];
    for (const [que, esperado] of [
      [null, 'ASIGNADO'],
      ['en-camino', 'EN_CAMINO'],
      ['iniciar', 'EN_CURSO'],
    ] as const) {
      if (que) await accion(solicitudId, a, que);
      const e = await estado(a);
      expect(e.viaje).toMatchObject({ id: solicitudId, estado: esperado });
      versiones.push(e.viaje!.version);
    }
    expect(versiones).toEqual([...versiones].sort((x, y) => x - y));
    await accion(solicitudId, a, 'finalizar');
    expect((await estado(a)).viaje).toBeNull();
  });

  it('si el pasajero cancela un viaje en camino, el chofer queda sin viaje', async () => {
    const a = randomUUID();
    const { solicitudId, pasajero } = await pedir([a]);
    await aceptar(solicitudId, a);
    await accion(solicitudId, a, 'en-camino');
    await request(d.url).post(`/solicitudes/${solicitudId}/cancelar`).set(clave()).set(await d.auth(pasajero, 'pasajero')).send({}).expect(200);
    expect((await estado(a)).viaje).toBeNull();
  });

  it('encuentra el viaje activo aunque sea más viejo que el último del historial', async () => {
    // El historial se ordena por creación: una solicitud pedida antes puede asignarse después de que
    // el chofer terminó otra más nueva. Por eso la pantalla no puede usar GET /historial?limite=1.
    const a = randomUUID();
    const vieja = await pedir([a]);
    const nueva = await pedir([a]);
    await aceptar(nueva.solicitudId, a);
    await accion(nueva.solicitudId, a, 'en-camino');
    await accion(nueva.solicitudId, a, 'iniciar');
    await accion(nueva.solicitudId, a, 'finalizar');
    expect((await aceptar(vieja.solicitudId, a)).status).toBe(200);

    const historial = await request(d.url).get('/historial?limite=1').set(await d.auth(a, 'chofer')).expect(200);
    expect(historial.body.viajes[0]).toMatchObject({ id: nueva.solicitudId, estado: 'COMPLETADA' });
    expect((await estado(a)).viaje).toMatchObject({ id: vieja.solicitudId, estado: 'ASIGNADO' });
  });

  it('con un viaje activo no muestra otras ofertas: aceptarlas daría CHOFER_CON_VIAJE_ACTIVO', async () => {
    const a = randomUUID();
    const primera = await pedir([a]);
    const segunda = await pedir([a]);
    await aceptar(primera.solicitudId, a);
    expect(await d.prisma.oferta.count({ where: { solicitudId: segunda.solicitudId, choferId: a, estado: 'PENDIENTE' } })).toBe(1);
    const e = await estado(a);
    expect(e.viaje?.id).toBe(primera.solicitudId);
    expect(e.ofertas).toEqual([]);
  });

  it('devuelve el registro propio en la flota, con la disponibilidad', async () => {
    const preparar = preparadorFlotas(d.casosFlotas, d.directorio);
    const flota = await preparar.flota(5);
    const a = await preparar.chofer(flota.id);
    expect((await estado(a)).registro).toMatchObject({ id: a, flotaId: flota.id, habilitado: true, activo: false, disponible: false });

    await d.casosFlotas.activarChofer({ fleetId: flota.id }, a);
    await request(d.url).put('/chofer/disponibilidad').set(clave()).set(await d.auth(a, 'chofer')).send({ disponible: true }).expect(200);
    expect((await estado(a)).registro).toMatchObject({ activo: true, disponible: true });
  });
});

describe('GET /chofer/estado: permisos', () => {
  it('sin token → 401', async () => {
    expect((await request(d.url).get('/chofer/estado')).status).toBe(401);
  });

  it.each(['pasajero', 'operador', 'admin'] as const)('%s → 403', async (rol) => {
    const res = await request(d.url).get('/chofer/estado').set(await d.auth(randomUUID(), rol));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROL_NO_PERMITIDO');
  });

  it('admin_flota → 403', async () => {
    const res = await request(d.url).get('/chofer/estado').set(await d.authFlota(randomUUID(), randomUUID()));
    expect(res.status).toBe(403);
  });

  it('no acepta parámetros para pedir el estado de otro: el chofer sale del token', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const { solicitudId } = await pedir([a]);
    await aceptar(solicitudId, a);
    const res = await request(d.url).get(`/chofer/estado?choferId=${a}`).set(await d.auth(b, 'chofer')).expect(200);
    expect(EstadoChoferRespuesta.parse(res.body)).toMatchObject({ viaje: null, ofertas: [] });
  });
});
