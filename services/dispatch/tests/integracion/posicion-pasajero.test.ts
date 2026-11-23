import { randomUUID } from 'node:crypto';
import { canalPosicionChofer, canalPosicionPasajero, TIPO_POSICION_CHOFER, TIPO_POSICION_PASAJERO } from '@viajes/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clave, DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';
import { abrirStream, deTipo, type StreamDePrueba } from '../soporte/sse.js';

/**
 * La posición del pasajero en el stream de su chofer (PLAN 3.5), contra Postgres y Redis reales: el
 * sentido inverso de posicion-chofer.test.ts. El test publica en el canal del pasajero como lo hace
 * location (`canalPosicionPasajero`, `PosicionPasajeroPublicada`).
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

const POSICION = 'PassengerLocationUpdated';
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = Date.parse('2026-11-23T12:00:00.000Z');

async function stream(usuario: string, rol: 'pasajero' | 'chofer') {
  const s = await abrirStream(`${d.url}/eventos`, await d.auth(usuario, rol));
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

async function viajeAsignado() {
  const pasajero = randomUUID();
  const chofer = randomUUID();
  const id = await pedir(pasajero, chofer);
  await aceptar(id, chofer);
  return { pasajero, chofer, id };
}

const canal = (pasajero: string) => canalPosicionPasajero(d.prefijoPosiciones, pasajero);

/** Lo que publica location cuando el pasajero informa su posición, `segundos` después de BASE. */
const posicion = (pasajero: string, segundos: number) => ({
  tipo: TIPO_POSICION_PASAJERO,
  pasajeroId: pasajero,
  lat: -34.6 + segundos / 10_000,
  lng: -58.38,
  actualizadaEn: new Date(BASE + segundos * 1000).toISOString(),
});

async function publicar(pasajero: string, mensaje: unknown) {
  await d.redis.publish(canal(pasajero), typeof mensaje === 'string' ? mensaje : JSON.stringify(mensaje));
}

async function suscriptos(c: string): Promise<number> {
  const [, n] = (await d.redis.pubsub('NUMSUB', c)) as [string, number];
  return Number(n);
}

/** Espera a que el canal del pasajero (o el que se pase) tenga `esperado` suscripciones. */
async function esperarSuscriptos(pasajero: string, esperado: number, c = canal(pasajero)) {
  const limite = Date.now() + 3000;
  while ((await suscriptos(c)) !== esperado) {
    if (Date.now() > limite) throw new Error(`el canal ${c} tiene ${await suscriptos(c)} suscripciones, no ${esperado}`);
    await dormir(20);
  }
}

const posiciones = (s: StreamDePrueba) => s.eventos.filter(deTipo(POSICION));

describe('el chofer ve a su pasajero en vivo', () => {
  it('desde que acepta hasta que termina el viaje; antes y después, nada', async () => {
    const pasajero = randomUUID();
    const chofer = randomUUID();
    const sc = await stream(chofer, 'chofer');
    const id = await pedir(pasajero, chofer);
    // Con la oferta todavía no es su viaje: no sigue a nadie.
    await dormir(100);
    expect(await suscriptos(canal(pasajero))).toBe(0);

    await aceptar(id, chofer);
    await sc.esperar(deTipo('TripAssigned'));
    await esperarSuscriptos(pasajero, 1);
    await publicar(pasajero, posicion(pasajero, 1));
    const recibida = await sc.esperar(deTipo(POSICION));
    expect(recibida.data).toEqual({
      solicitudId: id,
      pasajeroId: pasajero,
      lat: posicion(pasajero, 1).lat,
      lng: -58.38,
      actualizadaEn: posicion(pasajero, 1).actualizadaEn,
    });
    // Sin id: no se repone ni mueve el Last-Event-ID del cliente.
    expect(recibida.id).toBeUndefined();

    await accion(id, chofer, 'en-camino');
    await accion(id, chofer, 'iniciar');
    await publicar(pasajero, posicion(pasajero, 2));
    await sc.esperar((e) => e.tipo === POSICION && e.data['actualizadaEn'] === posicion(pasajero, 2).actualizadaEn);

    await accion(id, chofer, 'finalizar');
    await sc.esperar(deTipo('RideCompleted'));
    await esperarSuscriptos(pasajero, 0);
    await publicar(pasajero, posicion(pasajero, 3));
    await dormir(150);
    expect(posiciones(sc)).toHaveLength(2);
  });

  it('nadie más la ve: ni el pasajero, ni otro chofer, ni otro pasajero', async () => {
    const { pasajero, chofer } = await viajeAsignado();
    const sc = await stream(chofer, 'chofer');
    const sp = await stream(pasajero, 'pasajero');
    const otroChofer = await stream(randomUUID(), 'chofer');
    const otroPasajero = await stream(randomUUID(), 'pasajero');
    await esperarSuscriptos(pasajero, 1);

    await publicar(pasajero, posicion(pasajero, 1));
    await sc.esperar(deTipo(POSICION));
    await dormir(150);
    for (const s of [sp, otroChofer, otroPasajero]) expect(posiciones(s)).toEqual([]);
  });

  it('si el pasajero cancela, el chofer deja de seguirlo', async () => {
    const { pasajero, chofer, id } = await viajeAsignado();
    const sc = await stream(chofer, 'chofer');
    await esperarSuscriptos(pasajero, 1);

    await request(d.url).post(`/solicitudes/${id}/cancelar`).set(clave()).set(await d.auth(pasajero, 'pasajero')).send({}).expect(200);
    await d.relay();
    await sc.esperar(deTipo('RideCancelled'));
    await esperarSuscriptos(pasajero, 0);
    await publicar(pasajero, posicion(pasajero, 1));
    await dormir(150);
    expect(posiciones(sc)).toEqual([]);
  });

  it('al conectarse a mitad del viaje lo sigue enseguida, y cada uno ve al otro por su canal', async () => {
    const { pasajero, chofer, id } = await viajeAsignado();
    await accion(id, chofer, 'en-camino');

    const sc = await stream(chofer, 'chofer');
    const sp = await stream(pasajero, 'pasajero');
    await esperarSuscriptos(pasajero, 1);
    await esperarSuscriptos(pasajero, 1, canalPosicionChofer(d.prefijoPosiciones, chofer));

    await publicar(pasajero, posicion(pasajero, 1));
    await d.redis.publish(
      canalPosicionChofer(d.prefijoPosiciones, chofer),
      JSON.stringify({ tipo: TIPO_POSICION_CHOFER, choferId: chofer, lat: -34.61, lng: -58.39, actualizadaEn: new Date(BASE).toISOString() }),
    );
    await sc.esperar(deTipo(POSICION));
    await sp.esperar(deTipo('DriverLocationUpdated'));
    await dormir(100);
    expect(sc.eventos.some(deTipo('DriverLocationUpdated'))).toBe(false);
    expect(posiciones(sp)).toEqual([]);
  });
});

describe('qué posiciones del pasajero llegan', () => {
  it('una más vieja que la última, una de otro pasajero, una del contrato del chofer y una fuera de contrato se descartan', async () => {
    const { pasajero, chofer } = await viajeAsignado();
    const sc = await stream(chofer, 'chofer');
    await esperarSuscriptos(pasajero, 1);

    await publicar(pasajero, posicion(pasajero, 10));
    await publicar(pasajero, posicion(pasajero, 5)); // atrasada
    await publicar(pasajero, posicion(pasajero, 10)); // repetida
    await publicar(pasajero, posicion(randomUUID(), 20)); // otro pasajero en este canal
    // El contrato del chofer en el canal del pasajero, con el id del pasajero: tampoco pasa.
    const { pasajeroId, ...resto } = posicion(pasajero, 25);
    await publicar(pasajero, { ...resto, tipo: TIPO_POSICION_CHOFER, choferId: pasajeroId });
    await publicar(pasajero, 'no es json');
    await publicar(pasajero, { ...posicion(pasajero, 30), lng: 500 }); // fuera de contrato
    await publicar(pasajero, { ...posicion(pasajero, 30), extra: 'x' }); // fuera de contrato (strict)
    await publicar(pasajero, posicion(pasajero, 11));
    await sc.esperar((e) => e.tipo === POSICION && e.data['actualizadaEn'] === posicion(pasajero, 11).actualizadaEn);
    await dormir(100);
    expect(posiciones(sc).map((e) => e.data['actualizadaEn'])).toEqual([
      posicion(pasajero, 10).actualizadaEn,
      posicion(pasajero, 11).actualizadaEn,
    ]);
  });
});
