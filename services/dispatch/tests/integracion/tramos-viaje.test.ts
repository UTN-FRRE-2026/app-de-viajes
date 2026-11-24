import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { levantarDispatch } from '../soporte/sistema-postgres.js';

/** `POST /interno/tramos-viaje` contra Postgres: lo que location usa para la retención por viaje. */
const TOKEN = randomBytes(32).toString('base64url');
let d: Awaited<ReturnType<typeof levantarDispatch>>;

beforeAll(async () => {
  d = await levantarDispatch({ extra: { DISPATCH_TOKEN_SERVICIO: TOKEN } });
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
});

const T = (iso: string) => new Date(`2026-11-20T${iso}.000Z`);
type Estado = 'COMPLETADA' | 'EN_CURSO' | 'ASIGNADO' | 'CANCELADO_CHOFER';

/** Un viaje del chofer: la solicitud, su oferta aceptada (si se pide) y el último cambio. */
async function viaje(choferId: string, estado: Estado, { creada, aceptada, cambio }: { creada: Date; aceptada?: Date; cambio: Date }) {
  const id = randomUUID();
  await d.prisma.solicitudViaje.create({
    data: {
      id,
      pasajeroId: randomUUID(),
      estado,
      origenLat: -34.6,
      origenLng: -58.4,
      destinoLat: -34.61,
      destinoLng: -58.41,
      choferId,
      creadaEn: creada,
      actualizadaEn: cambio,
    },
  });
  if (aceptada) {
    await d.prisma.oferta.create({
      data: { id: randomUUID(), solicitudId: id, choferId, estado: 'ACEPTADA', venceEn: new Date(aceptada.getTime() + 15_000), creadaEn: aceptada },
    });
  }
  return id;
}

const consultar = (cuerpo: object, token: string | null = TOKEN) => {
  const r = request(d.url).post('/interno/tramos-viaje');
  return (token ? r.set('x-token-servicio', token) : r).send(cuerpo);
};

describe('POST /interno/tramos-viaje', () => {
  it('devuelve el tramo de cada viaje: de la oferta aceptada al último cambio, o abierto si sigue activo', async () => {
    const [a, b, otro] = [randomUUID(), randomUUID(), randomUUID()];
    await viaje(a, 'COMPLETADA', { creada: T('10:00:00'), aceptada: T('10:00:05'), cambio: T('10:30:00') });
    await viaje(a, 'EN_CURSO', { creada: T('11:00:00'), aceptada: T('11:00:03'), cambio: T('11:05:00') });
    // Cancelado por el chofer después de asignado, sin oferta: el tramo empieza con la solicitud.
    await viaje(b, 'CANCELADO_CHOFER', { creada: T('10:10:00'), cambio: T('10:20:00') });
    // Fuera del rango: terminó antes de `desde`, o empezó después de `hasta`.
    await viaje(b, 'COMPLETADA', { creada: T('08:00:00'), aceptada: T('08:00:02'), cambio: T('08:30:00') });
    await viaje(a, 'COMPLETADA', { creada: T('13:00:00'), aceptada: T('13:00:02'), cambio: T('13:30:00') });
    // Otro chofer, que no se pidió.
    await viaje(otro, 'COMPLETADA', { creada: T('10:00:00'), aceptada: T('10:00:01'), cambio: T('10:40:00') });

    const res = await consultar({ choferes: [a, b], desde: T('09:00:00').toISOString(), hasta: T('12:00:00').toISOString() });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const ordenar = (t: { choferId: string; inicio: string }[]) => [...t].sort((x, y) => (x.inicio < y.inicio ? -1 : 1));
    expect(ordenar(res.body.tramos)).toEqual([
      { choferId: a, inicio: T('10:00:05').toISOString(), fin: T('10:30:00').toISOString() },
      { choferId: b, inicio: T('10:10:00').toISOString(), fin: T('10:20:00').toISOString() },
      { choferId: a, inicio: T('11:00:03').toISOString(), fin: null },
    ]);
  });

  it('un viaje activo cubre cualquier rango posterior a su inicio', async () => {
    const c = randomUUID();
    await viaje(c, 'ASIGNADO', { creada: T('10:00:00'), aceptada: T('10:00:02'), cambio: T('10:00:02') });
    const res = await consultar({ choferes: [c], desde: T('23:00:00').toISOString(), hasta: T('23:00:01').toISOString() });
    expect(res.body.tramos).toEqual([{ choferId: c, inicio: T('10:00:02').toISOString(), fin: null }]);
  });

  it('sin el token de servicio, o con el JWT de un usuario, 401', async () => {
    const cuerpo = { choferes: [randomUUID()], desde: T('09:00:00').toISOString(), hasta: T('10:00:00').toISOString() };
    expect((await consultar(cuerpo, null)).status).toBe(401);
    expect((await consultar(cuerpo, 'x'.repeat(40))).status).toBe(401);
    const conJwt = await request(d.url).post('/interno/tramos-viaje').set(await d.auth(randomUUID(), 'admin')).send(cuerpo);
    expect(conJwt.status).toBe(401);
  });

  it('acepta 1000 choferes (unos 39 KB, más que el límite de 16 KB de las rutas públicas)', async () => {
    const choferes = Array.from({ length: 1000 }, () => randomUUID());
    const res = await consultar({ choferes, desde: T('09:00:00').toISOString(), hasta: T('10:00:00').toISOString() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tramos: [] });
  });

  it('las rutas públicas siguen con el límite de 16 KB', async () => {
    const res = await request(d.url)
      .post('/solicitudes')
      .set(await d.auth(randomUUID(), 'pasajero'))
      .set('Idempotency-Key', randomUUID())
      .send({ origen: { lat: -34.6, lng: -58.4 }, destino: { lat: -34.61, lng: -58.41 }, relleno: 'x'.repeat(20_000) });
    expect(res.status).toBe(413);
  });

  it.each([
    ['más de 1000 choferes', { choferes: Array.from({ length: 1001 }, () => randomUUID()) }],
    ['ningún chofer', { choferes: [] }],
    ['desde igual a hasta', { desde: T('10:00:00').toISOString(), hasta: T('10:00:00').toISOString() }],
    ['una clave extra', { estado: 'COMPLETADA' }],
  ])('rechaza %s con 400', async (_caso, cambios) => {
    const cuerpo = { choferes: [randomUUID()], desde: T('09:00:00').toISOString(), hasta: T('10:00:00').toISOString(), ...cambios };
    const res = await consultar(cuerpo);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDACION');
  });
});
