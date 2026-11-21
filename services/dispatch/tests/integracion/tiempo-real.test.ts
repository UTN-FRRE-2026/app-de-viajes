import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clave, DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';
import { abrirStream, deTipo, type StreamDePrueba } from '../soporte/sse.js';

/** Tiempo real por SSE (PLAN 3.5), contra Postgres y Redis reales: outbox → relay → Pub/Sub → stream. */
let d: Awaited<ReturnType<typeof levantarDispatch>>;
const abiertos: StreamDePrueba[] = [];

beforeAll(async () => {
  d = await levantarDispatch();
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
  await d.relay(); // nada pendiente de otro test
});
afterEach(() => {
  for (const s of abiertos.splice(0)) s.cerrar();
});

const cuerpo = { origen: ORIGEN, destino: DESTINO };
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stream(usuario: string, rol: 'pasajero' | 'chofer', extra: Record<string, string> = {}) {
  const s = await abrirStream(`${d.url}/eventos`, { ...(await d.auth(usuario, rol)), ...extra });
  abiertos.push(s);
  return s;
}

/** Crea una solicitud ofrecida a `choferes` y publica sus eventos. */
async function pedir(pasajero: string, choferes: string[]) {
  d.buscador.choferes = choferes;
  const res = await request(d.url).post('/solicitudes').set(clave()).set(await d.auth(pasajero, 'pasajero')).send(cuerpo);
  expect(res.status).toBe(201);
  await d.relay();
  return res.body.id as string;
}

async function aceptar(solicitudId: string, chofer: string) {
  const oferta = await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId, choferId: chofer } });
  await request(d.url).post(`/ofertas/${oferta.id}/aceptar`).set(clave()).set(await d.auth(chofer, 'chofer')).send({}).expect(200);
  await d.relay();
}

async function accion(solicitudId: string, chofer: string, que: 'en-camino' | 'iniciar' | 'finalizar') {
  await request(d.url).post(`/solicitudes/${solicitudId}/${que}`).set(clave()).set(await d.auth(chofer, 'chofer')).send({}).expect(200);
  await d.relay();
}

describe('los eventos del viaje llegan en vivo', () => {
  it('el pasajero ve su viaje de punta a punta y el chofer, su oferta y su viaje', async () => {
    const pasajero = randomUUID();
    const chofer = randomUUID();
    const sp = await stream(pasajero, 'pasajero');
    const sc = await stream(chofer, 'chofer');
    expect(sp.estado).toBe(200);
    expect(sp.encabezados['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(sp.encabezados['cache-control']).toBe('no-cache, no-transform');
    expect(sp.encabezados['x-accel-buffering']).toBe('no');

    const id = await pedir(pasajero, [chofer]);
    expect((await sp.esperar(deTipo('RideRequested'))).data).toMatchObject({ solicitudId: id, pasajeroId: pasajero });
    expect((await sc.esperar(deTipo('OfferCreated'))).data).toMatchObject({ solicitudId: id, choferId: chofer });

    await aceptar(id, chofer);
    for (const s of [sp, sc]) expect((await s.esperar(deTipo('TripAssigned'))).data).toMatchObject({ solicitudId: id, choferId: chofer });
    for (const que of ['en-camino', 'iniciar', 'finalizar'] as const) await accion(id, chofer, que);
    await sp.esperar(deTipo('RideCompleted'));
    await sc.esperar(deTipo('RideCompleted'));

    expect(sp.eventos.map((e) => e.tipo)).toEqual(['RideRequested', 'TripAssigned', 'DriverEnRoute', 'TripStarted', 'RideCompleted']);
    // Los ids son el seq del outbox: crecen.
    const ids = sp.eventos.map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('el pasajero ve el cobro de su viaje; el chofer, no', async () => {
    const pasajero = randomUUID();
    const chofer = randomUUID();
    const id = await pedir(pasajero, [chofer]);
    await aceptar(id, chofer);
    for (const que of ['en-camino', 'iniciar', 'finalizar'] as const) await accion(id, chofer, que);
    const sp = await stream(pasajero, 'pasajero');
    const sc = await stream(chofer, 'chofer');

    await d.casos.cobrarPendientes();
    await d.relay();
    expect((await sp.esperar(deTipo('PaymentCaptured'))).data).toMatchObject({ solicitudId: id, pasajeroId: pasajero });
    await dormir(200);
    expect(sc.eventos.map((e) => e.tipo)).not.toContain('PaymentCaptured');
  });
});

describe('cada uno ve solo lo suyo', () => {
  it('otro pasajero y otro chofer conectados no reciben nada; un chofer no ve la oferta de otro', async () => {
    const pasajero = randomUUID();
    const [chofer1, chofer2] = [randomUUID(), randomUUID()];
    const ajenoPasajero = await stream(randomUUID(), 'pasajero');
    const ajenoChofer = await stream(randomUUID(), 'chofer');
    const s1 = await stream(chofer1, 'chofer');
    const s2 = await stream(chofer2, 'chofer');

    const id = await pedir(pasajero, [chofer1, chofer2]);
    const oferta1 = await s1.esperar(deTipo('OfferCreated'));
    const oferta2 = await s2.esperar(deTipo('OfferCreated'));
    expect(oferta1.data['choferId']).toBe(chofer1);
    expect(oferta2.data['choferId']).toBe(chofer2);
    expect(s1.eventos).toHaveLength(1);
    expect(s2.eventos).toHaveLength(1);

    await aceptar(id, chofer1);
    await s1.esperar(deTipo('TripAssigned'));
    // Al otro chofer no le llega el viaje que aceptó el primero.
    await dormir(200);
    expect(s2.eventos.map((e) => e.tipo)).not.toContain('TripAssigned');
    expect(ajenoPasajero.eventos).toEqual([]);
    expect(ajenoChofer.eventos).toEqual([]);
  });
});

describe('cada uno ve solo lo suyo, también al reponer', () => {
  it('Last-Event-ID: 0 de un usuario ajeno no repone los eventos de otros', async () => {
    const pasajero = randomUUID();
    const chofer = randomUUID();
    const id = await pedir(pasajero, [chofer]);
    await aceptar(id, chofer);
    expect(await d.prisma.eventoOutbox.count()).toBeGreaterThan(0);

    const ajeno = await stream(randomUUID(), 'pasajero', { 'Last-Event-ID': '0' });
    const propio = await stream(pasajero, 'pasajero', { 'Last-Event-ID': '0' });
    await propio.esperar(deTipo('TripAssigned'));
    await dormir(200);
    expect(ajeno.eventos).toEqual([]);
    expect(propio.eventos.map((e) => e.tipo)).toEqual(['RideRequested', 'TripAssigned']);
  });
});

describe('reconexión con Last-Event-ID', () => {
  it('repone exactamente lo que se perdió mientras estaba desconectado, sin repetir, y sigue en vivo', async () => {
    const pasajero = randomUUID();
    const chofer = randomUUID();
    const primera = await stream(pasajero, 'pasajero');
    const id = await pedir(pasajero, [chofer]);
    const ultimo = await primera.esperar(deTipo('RideRequested'));
    primera.cerrar();

    // Mientras está desconectado: aceptan y el chofer sale.
    await aceptar(id, chofer);
    await accion(id, chofer, 'en-camino');

    const segunda = await stream(pasajero, 'pasajero', { 'Last-Event-ID': ultimo.id as string });
    await segunda.esperar(deTipo('DriverEnRoute'));
    expect(segunda.eventos.map((e) => e.tipo)).toEqual(['TripAssigned', 'DriverEnRoute']);

    // Y lo nuevo sigue llegando en vivo.
    await accion(id, chofer, 'iniciar');
    await segunda.esperar(deTipo('TripStarted'));
    expect(segunda.eventos.map((e) => e.tipo)).toEqual(['TripAssigned', 'DriverEnRoute', 'TripStarted']);
  });

  it('repone también lo que el relay todavía no publicó, y no lo repite cuando se publica', async () => {
    const pasajero = randomUUID();
    const chofer = randomUUID();
    const id = await pedir(pasajero, [chofer]);
    const [requested] = await d.prisma.eventoOutbox.findMany({ where: { tipo: 'RideRequested', destinatarios: { has: pasajero } } });

    // Aceptado, pero el relay todavía no corrió.
    const oferta = await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId: id } });
    await request(d.url).post(`/ofertas/${oferta.id}/aceptar`).set(clave()).set(await d.auth(chofer, 'chofer')).send({}).expect(200);

    const s = await stream(pasajero, 'pasajero', { 'Last-Event-ID': String(requested!.seq) });
    await s.esperar(deTipo('TripAssigned'));
    await d.relay();
    await dormir(200);
    expect(s.eventos.map((e) => e.tipo)).toEqual(['TripAssigned']);
  });

  it('un evento publicado dos veces (el relay se cayó antes de marcarlo) llega una sola vez', async () => {
    const pasajero = randomUUID();
    const s = await stream(pasajero, 'pasajero');
    const evento = { seq: 999_999_999, tipo: 'NoDriversFound', payload: { solicitudId: randomUUID(), pasajeroId: pasajero }, destinatarios: [pasajero] };
    await d.bus.publicar(evento);
    await d.bus.publicar(evento);
    await s.esperar(deTipo('NoDriversFound'));
    await dormir(200);
    expect(s.eventos).toHaveLength(1);
  });

  it('Last-Event-ID que no es un número → 400', async () => {
    const s = await stream(randomUUID(), 'pasajero', { 'Last-Event-ID': "1' OR '1'='1" });
    expect(s.estado).toBe(400);
    expect(JSON.parse(s.cuerpo()).error.code).toBe('LAST_EVENT_ID_INVALIDO');
  });
});

describe('acceso y límites', () => {
  it('sin token 401; operador y admin de flota 403', async () => {
    const sinToken = await abrirStream(`${d.url}/eventos`, {});
    abiertos.push(sinToken);
    expect(sinToken.estado).toBe(401);
    for (const rol of ['operador', 'admin_flota'] as const) {
      const s = await abrirStream(`${d.url}/eventos`, await d.auth(randomUUID(), rol));
      abiertos.push(s);
      expect(s.estado).toBe(403);
    }
  });

  it('como mucho 3 streams por usuario: el cuarto recibe 429, y al cerrar uno se libera el lugar', async () => {
    const pasajero = randomUUID();
    const tres = [await stream(pasajero, 'pasajero'), await stream(pasajero, 'pasajero'), await stream(pasajero, 'pasajero')];
    expect(tres.map((s) => s.estado)).toEqual([200, 200, 200]);
    const cuarto = await stream(pasajero, 'pasajero');
    expect(cuarto.estado).toBe(429);
    expect(JSON.parse(cuarto.cuerpo()).error.code).toBe('DEMASIADAS_CONEXIONES');
    // Otro usuario no se ve afectado.
    expect((await stream(randomUUID(), 'pasajero')).estado).toBe(200);

    tres[0]!.cerrar();
    await dormir(100);
    expect((await stream(pasajero, 'pasajero')).estado).toBe(200);
  });

  it('el stream se cierra cuando vence el token', async () => {
    const s = await abrirStream(`${d.url}/eventos`, await d.auth(randomUUID(), 'pasajero', '2s'));
    abiertos.push(s);
    expect(s.estado).toBe(200);
    const inicio = Date.now();
    await s.cerrado;
    expect(Date.now() - inicio).toBeLessThan(3500);
  });

  it('al apagar, los streams se cortan (no hacen esperar al servidor)', async () => {
    const s = await stream(randomUUID(), 'pasajero');
    expect(d.streams.cantidad).toBeGreaterThan(0);
    d.streams.cerrarTodos();
    await s.cerrado;
    expect(d.streams.cantidad).toBe(0);
  });
});

describe('el relay', () => {
  it('marca publicado lo que publicó: la segunda pasada no publica nada', async () => {
    await pedir(randomUUID(), []);
    expect(await d.prisma.eventoOutbox.count({ where: { publicadoEn: null } })).toBe(0);
    expect(await d.relay()).toBe(0);
  });

  it('cada evento guarda a quién se entrega: pasajero y chofer del payload', async () => {
    const pasajero = randomUUID();
    const chofer = randomUUID();
    const id = await pedir(pasajero, [chofer]);
    await aceptar(id, chofer);
    const asignado = await d.prisma.eventoOutbox.findFirstOrThrow({ where: { tipo: 'TripAssigned' } });
    expect(new Set(asignado.destinatarios)).toEqual(new Set([pasajero, chofer]));
    const oferta = await d.prisma.eventoOutbox.findFirstOrThrow({ where: { tipo: 'OfferCreated' } });
    expect(oferta.destinatarios).toEqual([chofer]);
  });
});
