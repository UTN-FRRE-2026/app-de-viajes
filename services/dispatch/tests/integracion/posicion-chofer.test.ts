import { randomUUID } from 'node:crypto';
import { canalPosicionChofer, TIPO_POSICION_CHOFER } from '@viajes/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clave, DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';
import { abrirStream, deTipo, type StreamDePrueba } from '../soporte/sse.js';

/**
 * La posición del chofer en el stream del pasajero (PLAN 3.5), contra Postgres y Redis reales. El test
 * publica en el canal del chofer como lo hace location (`canalPosicionChofer`, `PosicionChoferPublicada`).
 */
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
  await d.relay();
});
afterEach(() => {
  for (const s of abiertos.splice(0)) s.cerrar();
});

const POSICION = 'DriverLocationUpdated';
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = Date.parse('2026-11-21T12:00:00.000Z');

async function stream(usuario: string, rol: 'pasajero' | 'chofer', extra: Record<string, string> = {}) {
  const s = await abrirStream(`${d.url}/eventos`, { ...(await d.auth(usuario, rol)), ...extra });
  expect(s.estado).toBe(200);
  abiertos.push(s);
  return s;
}

async function pedir(pasajero: string, chofer: string) {
  d.buscador.choferes = [chofer];
  const res = await request(d.url)
    .post('/solicitudes')
    .set(clave())
    .set(await d.auth(pasajero, 'pasajero'))
    .send({ origen: ORIGEN, destino: DESTINO });
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

/** Un viaje con chofer asignado. */
async function viajeAsignado() {
  const pasajero = randomUUID();
  const chofer = randomUUID();
  const id = await pedir(pasajero, chofer);
  await aceptar(id, chofer);
  return { pasajero, chofer, id };
}

const canal = (chofer: string) => canalPosicionChofer(d.prefijoPosiciones, chofer);

/** Lo que publica location por cada ping, `segundos` después de BASE. */
const posicion = (chofer: string, segundos: number) => ({
  tipo: TIPO_POSICION_CHOFER,
  choferId: chofer,
  lat: -34.6 + segundos / 10_000,
  lng: -58.38,
  actualizadaEn: new Date(BASE + segundos * 1000).toISOString(),
});

async function publicar(chofer: string, mensaje: unknown) {
  await d.redis.publish(canal(chofer), typeof mensaje === 'string' ? mensaje : JSON.stringify(mensaje));
}

/** Suscripciones de Redis al canal del chofer, en todo el servidor. */
async function suscriptos(chofer: string): Promise<number> {
  const [, n] = (await d.redis.pubsub('NUMSUB', canal(chofer))) as [string, number];
  return Number(n);
}

async function esperarSuscriptos(chofer: string, esperado: number) {
  const limite = Date.now() + 3000;
  while ((await suscriptos(chofer)) !== esperado) {
    if (Date.now() > limite) throw new Error(`el canal de ${chofer} tiene ${await suscriptos(chofer)} suscripciones, no ${esperado}`);
    await dormir(20);
  }
}

const posiciones = (s: StreamDePrueba) => s.eventos.filter(deTipo(POSICION));

describe('el pasajero ve a su chofer en vivo', () => {
  it('desde que se asigna hasta que termina el viaje; antes y después, nada', async () => {
    const pasajero = randomUUID();
    const chofer = randomUUID();
    const sp = await stream(pasajero, 'pasajero');
    const id = await pedir(pasajero, chofer);
    await sp.esperar(deTipo('RideRequested'));
    // Buscando chofer: todavía no hay a quién seguir.
    await dormir(100);
    expect(await suscriptos(chofer)).toBe(0);

    await aceptar(id, chofer);
    await esperarSuscriptos(chofer, 1);
    await publicar(chofer, posicion(chofer, 1));
    const recibida = await sp.esperar(deTipo(POSICION));
    expect(recibida.data).toEqual({
      solicitudId: id,
      choferId: chofer,
      lat: posicion(chofer, 1).lat,
      lng: -58.38,
      actualizadaEn: posicion(chofer, 1).actualizadaEn,
    });
    // Sin id: no se repone ni mueve el Last-Event-ID del cliente.
    expect(recibida.id).toBeUndefined();

    await accion(id, chofer, 'en-camino');
    await accion(id, chofer, 'iniciar');
    await publicar(chofer, posicion(chofer, 2));
    await sp.esperar((e) => e.tipo === POSICION && e.data['actualizadaEn'] === posicion(chofer, 2).actualizadaEn);

    await accion(id, chofer, 'finalizar');
    await sp.esperar(deTipo('RideCompleted'));
    await esperarSuscriptos(chofer, 0);
    await publicar(chofer, posicion(chofer, 3));
    await dormir(150);
    expect(posiciones(sp)).toHaveLength(2);
  });

  it('nadie más la ve: ni el chofer, ni otro pasajero, ni otro chofer', async () => {
    const { pasajero, chofer } = await viajeAsignado();
    const sp = await stream(pasajero, 'pasajero');
    const sc = await stream(chofer, 'chofer');
    const otroPasajero = await stream(randomUUID(), 'pasajero');
    const otroChofer = await stream(randomUUID(), 'chofer');
    await esperarSuscriptos(chofer, 1);

    await publicar(chofer, posicion(chofer, 1));
    await sp.esperar(deTipo(POSICION));
    await dormir(150);
    for (const s of [sc, otroPasajero, otroChofer]) expect(posiciones(s)).toEqual([]);
  });

  it('si el pasajero cancela, deja de seguir al chofer', async () => {
    const { pasajero, chofer, id } = await viajeAsignado();
    const sp = await stream(pasajero, 'pasajero');
    await esperarSuscriptos(chofer, 1);

    await request(d.url).post(`/solicitudes/${id}/cancelar`).set(clave()).set(await d.auth(pasajero, 'pasajero')).send({}).expect(200);
    await d.relay();
    await sp.esperar(deTipo('RideCancelled'));
    await esperarSuscriptos(chofer, 0);
    await publicar(chofer, posicion(chofer, 1));
    await dormir(150);
    expect(posiciones(sp)).toEqual([]);
  });
});

describe('conexión y reconexión', () => {
  it('al conectarse a mitad del viaje lo sigue enseguida; dos pestañas comparten una sola suscripción', async () => {
    const { pasajero, chofer, id } = await viajeAsignado();
    await accion(id, chofer, 'en-camino');

    const pestana1 = await stream(pasajero, 'pasajero');
    const pestana2 = await stream(pasajero, 'pasajero');
    await esperarSuscriptos(chofer, 1);
    await publicar(chofer, posicion(chofer, 1));
    await pestana1.esperar(deTipo(POSICION));
    await pestana2.esperar(deTipo(POSICION));

    pestana1.cerrar();
    await dormir(100);
    expect(await suscriptos(chofer)).toBe(1);
    pestana2.cerrar();
    await esperarSuscriptos(chofer, 0);
  });

  it('reponer los eventos de un viaje que ya terminó no vuelve a seguir a su chofer', async () => {
    // El chofer a seguir sale de la base, no de interpretar los eventos: la reposición trae el
    // TripAssigned de un viaje terminado, y ese chofer ya no es de este pasajero.
    const { pasajero, chofer, id } = await viajeAsignado();
    for (const que of ['en-camino', 'iniciar', 'finalizar'] as const) await accion(id, chofer, que);

    const sp = await stream(pasajero, 'pasajero', { 'Last-Event-ID': '0' });
    await sp.esperar(deTipo('RideCompleted'));
    expect(sp.eventos.some(deTipo('TripAssigned'))).toBe(true);
    await dormir(150);
    expect(await suscriptos(chofer)).toBe(0);
  });
});

describe('qué posiciones llegan', () => {
  it('una más vieja que la última, una de otro chofer en el canal y una fuera de contrato se descartan', async () => {
    const { pasajero, chofer } = await viajeAsignado();
    const sp = await stream(pasajero, 'pasajero');
    await esperarSuscriptos(chofer, 1);

    await publicar(chofer, posicion(chofer, 10));
    await publicar(chofer, posicion(chofer, 5)); // atrasada
    await publicar(chofer, posicion(chofer, 10)); // repetida
    await publicar(chofer, posicion(randomUUID(), 20)); // otro chofer en este canal
    await publicar(chofer, 'no es json');
    await publicar(chofer, { ...posicion(chofer, 30), lat: 200 }); // fuera de contrato
    await publicar(chofer, { ...posicion(chofer, 30), extra: 'x' }); // fuera de contrato (strict)
    await publicar(chofer, posicion(chofer, 11));
    await sp.esperar((e) => e.tipo === POSICION && e.data['actualizadaEn'] === posicion(chofer, 11).actualizadaEn);
    await dormir(100);
    expect(posiciones(sp).map((e) => e.data['actualizadaEn'])).toEqual([
      posicion(chofer, 10).actualizadaEn,
      posicion(chofer, 11).actualizadaEn,
    ]);
  });
});
