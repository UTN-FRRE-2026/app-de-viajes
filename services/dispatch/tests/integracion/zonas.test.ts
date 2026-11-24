import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { preparadorFlotas } from '../soporte/flotas.js';
import { clave, DESTINO, levantarDispatch } from '../soporte/sistema-postgres.js';

/**
 * Zonas en PostGIS real (dispatch_test) y el filtro de candidatos con dos flotas: cada condición del
 * filtro, la zona del origen, la regla del borde, y la zona y la flota guardadas en el viaje.
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
  await d.sinZonaDeTest();
});

const ADMIN = randomUUID();
const comoAdmin = () => d.auth(ADMIN, 'admin');

// Dos zonas que se tocan en el borde lat -34.60 (Norte arriba, Sur abajo). Norte tiene el id menor.
const NORTE = '00000000-0000-4000-8000-00000000000a';
const SUR = '00000000-0000-4000-8000-00000000000b';
const rectangulo = (lng1: number, lat1: number, lng2: number, lat2: number) => ({
  type: 'Polygon' as const,
  coordinates: [
    [
      [lng1, lat1],
      [lng2, lat1],
      [lng2, lat2],
      [lng1, lat2],
      [lng1, lat1],
    ],
  ],
});
const AREA_NORTE = rectangulo(-58.5, -34.6, -58.4, -34.5);
const AREA_SUR = rectangulo(-58.5, -34.7, -58.4, -34.6);
const EN_NORTE = { lat: -34.55, lng: -58.45 };
const EN_SUR = { lat: -34.65, lng: -58.45 };
const EN_EL_BORDE = { lat: -34.6, lng: -58.45 };
const AFUERA = { lat: -34.4, lng: -58.45 };

const guardarZona = async (id: string, nombre: string, area: unknown, encabezados = clave()) =>
  request(d.url).put(`/admin/zonas/${id}`).set(encabezados).set(await comoAdmin()).send({ nombre, area });
const zonasDeFlota = async (flotaId: string, zonas: string[]) =>
  request(d.url).put(`/admin/flotas/${flotaId}/zonas`).set(clave()).set(await comoAdmin()).send({ zonas });

async function pedir(origen: { lat: number; lng: number }, pasajero = randomUUID()) {
  return request(d.url).post('/solicitudes').set(clave()).set(await d.auth(pasajero, 'pasajero')).send({ origen, destino: DESTINO });
}

/** Un chofer de la flota con el estado pedido, preparado por los casos de uso. */
async function chofer(flotaId: string, estado: { habilitado?: boolean; activo?: boolean; disponible?: boolean } = {}) {
  const { habilitado = true, activo = true, disponible = true } = estado;
  const id = await preparar.chofer(flotaId, { habilitado });
  if (activo) await d.casosFlotas.activarChofer({ fleetId: flotaId }, id);
  if (disponible) await d.casosFlotas.cambiarDisponibilidad(id, true);
  return id;
}

const ofrecidos = async (solicitudId: string) =>
  (await d.prisma.oferta.findMany({ where: { solicitudId } })).map((o) => o.choferId).sort();

describe('zonas: el admin las define y PostGIS las valida', () => {
  it('crea, lista y cambia una zona; dos zonas que solo se tocan en el borde conviven', async () => {
    expect((await guardarZona(NORTE, 'Norte', AREA_NORTE)).status).toBe(200);
    const sur = await guardarZona(SUR, 'Sur', AREA_SUR);
    expect(sur.status).toBe(200);
    expect(sur.body).toEqual({ id: SUR, nombre: 'Sur', area: AREA_SUR });
    expect((await guardarZona(SUR, 'Sur (renombrada)', AREA_SUR)).body.nombre).toBe('Sur (renombrada)');
    const lista = await request(d.url).get('/admin/zonas').set(await comoAdmin());
    expect(lista.body.zonas.map((z: { id: string }) => z.id).sort()).toEqual([NORTE, SUR]);
  });

  it('una zona que se superpone con otra: 409 ZONAS_SUPERPUESTAS y no se guarda', async () => {
    expect((await guardarZona(NORTE, 'Norte', AREA_NORTE)).status).toBe(200);
    const otra = randomUUID();
    const res = await guardarZona(otra, 'Centro', rectangulo(-58.45, -34.58, -58.35, -34.52));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ZONAS_SUPERPUESTAS');
    expect(await d.prisma.zona.count()).toBe(1);
  });

  it('dos PUT simultáneos de zonas superpuestas: el advisory lock deja pasar uno solo', async () => {
    const resultados = await Promise.all(
      Array.from({ length: 6 }, (_, i) => guardarZona(randomUUID(), `Z${i}`, rectangulo(-58.5 + i * 0.01, -34.6, -58.4 + i * 0.01, -34.5))),
    );
    expect(resultados.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    expect(await d.prisma.zona.count()).toBe(1);
  });

  it('un polígono que se cruza consigo mismo: 422 ZONA_INVALIDA (lo decide PostGIS)', async () => {
    const corbata = {
      type: 'Polygon',
      coordinates: [
        [
          [-58.5, -34.5],
          [-58.4, -34.6],
          [-58.5, -34.6],
          [-58.4, -34.5],
          [-58.5, -34.5],
        ],
      ],
    };
    const res = await guardarZona(randomUUID(), 'Corbata', corbata);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ZONA_INVALIDA');
  });

  it.each([
    ['el anillo abierto', { type: 'Polygon', coordinates: [[[-58.5, -34.5], [-58.4, -34.5], [-58.4, -34.6], [-58.5, -34.6]]] }],
    ['con un hueco', { type: 'Polygon', coordinates: [AREA_NORTE.coordinates[0], AREA_NORTE.coordinates[0]] }],
    ['una latitud fuera de rango', rectangulo(-58.5, -95, -58.4, -34.5)],
    ['otro tipo de geometría', { type: 'Point', coordinates: [-58.5, -34.5] }],
  ])('validación del cuerpo: %s → 400', async (_caso, area) => {
    expect((await guardarZona(randomUUID(), 'X', area)).status).toBe(400);
  });

  it('las zonas de una flota: 404 si la flota o la zona no existen; solo el admin', async () => {
    expect((await guardarZona(NORTE, 'Norte', AREA_NORTE)).status).toBe(200);
    const flota = await preparar.flota(5);
    expect((await zonasDeFlota(randomUUID(), [NORTE])).body.error.code).toBe('FLOTA_NO_ENCONTRADA');
    expect((await zonasDeFlota(flota.id, [randomUUID()])).body.error.code).toBe('ZONA_NO_ENCONTRADA');
    expect((await zonasDeFlota(flota.id, [NORTE])).body).toEqual({ flotaId: flota.id, zonas: [NORTE] });
    const comoFlota = await request(d.url)
      .put(`/admin/flotas/${flota.id}/zonas`)
      .set(clave())
      .set(await d.authFlota(randomUUID(), flota.id))
      .send({ zonas: [] });
    expect(comoFlota.status).toBe(403);
  });
});

describe('el filtro de candidatos con dos flotas en zonas distintas', () => {
  let a: string;
  let b: string;
  let deA: { apto: string; sinHabilitar: string; inactivo: string; noDisponible: string; ocupado: string };
  let deB: string;

  beforeEach(async () => {
    expect((await guardarZona(NORTE, 'Norte', AREA_NORTE)).status).toBe(200);
    expect((await guardarZona(SUR, 'Sur', AREA_SUR)).status).toBe(200);
    a = (await preparar.flota(10)).id;
    b = (await preparar.flota(10)).id;
    expect((await zonasDeFlota(a, [NORTE])).status).toBe(200);
    expect((await zonasDeFlota(b, [SUR])).status).toBe(200);
    deA = {
      apto: await chofer(a),
      sinHabilitar: await chofer(a, { habilitado: false, activo: false, disponible: false }),
      inactivo: await chofer(a, { activo: false, disponible: false }),
      noDisponible: await chofer(a, { disponible: false }),
      ocupado: await chofer(a),
    };
    deB = await chofer(b);
    // El ocupado toma un viaje antes: queda con un viaje activo.
    d.buscador.choferes = [deA.ocupado];
    const previa = await pedir(EN_NORTE);
    const oferta = await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId: previa.body.id } });
    await request(d.url).post(`/ofertas/${oferta.id}/aceptar`).set(clave()).set(await d.auth(deA.ocupado, 'chofer')).send({}).expect(200);
    // location los devuelve a todos, el de la otra flota primero (el más cercano).
    d.buscador.choferes = [deB, deA.sinHabilitar, deA.inactivo, deA.noDisponible, deA.ocupado, deA.apto];
  });

  it('origen en Norte: solo el apto de la flota A (no el de B, aunque esté más cerca, ni los otros de A)', async () => {
    const res = await pedir(EN_NORTE);
    expect(res.status).toBe(201);
    expect(await ofrecidos(res.body.id)).toEqual([deA.apto]);
    expect((await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: res.body.id } })).zonaId).toBe(NORTE);
  });

  it('origen en Sur: solo el de la flota B', async () => {
    const res = await pedir(EN_SUR);
    expect(await ofrecidos(res.body.id)).toEqual([deB]);
  });

  it('origen en el borde compartido: gana la zona de menor id (Norte)', async () => {
    const res = await pedir(EN_EL_BORDE);
    expect((await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: res.body.id } })).zonaId).toBe(NORTE);
    expect(await ofrecidos(res.body.id)).toEqual([deA.apto]);
  });

  it('origen fuera de toda zona: 422 ORIGEN_FUERA_DE_ZONA y no se crea nada', async () => {
    const antes = await d.prisma.solicitudViaje.count();
    const res = await pedir(AFUERA);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ORIGEN_FUERA_DE_ZONA');
    expect(await d.prisma.solicitudViaje.count()).toBe(antes);
  });

  it('al aceptar se guardan la zona y la flota del chofer', async () => {
    const res = await pedir(EN_NORTE);
    const oferta = await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId: res.body.id } });
    await request(d.url).post(`/ofertas/${oferta.id}/aceptar`).set(clave()).set(await d.auth(deA.apto, 'chofer')).send({}).expect(200);
    expect(await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: res.body.id } })).toMatchObject({
      estado: 'ASIGNADO',
      zonaId: NORTE,
      flotaId: a,
    });
  });

  it('si la flota deja de operar en la zona, sus choferes ya no reciben ofertas de ahí', async () => {
    expect((await zonasDeFlota(a, [])).status).toBe(200);
    const res = await pedir(EN_NORTE);
    expect(res.body.estado).toBe('SIN_CHOFERES');
  });
});

describe('una solicitud de antes de las zonas (zone_id NULL) con una oferta pendiente', () => {
  it('aceptar aplica las reglas nuevas: resuelve la zona, revalida al chofer y guarda zona y flota', async () => {
    expect((await guardarZona(NORTE, 'Norte', AREA_NORTE)).status).toBe(200);
    const a = (await preparar.flota(5)).id;
    expect((await zonasDeFlota(a, [NORTE])).status).toBe(200);
    const [apto, inactivo] = [await chofer(a), await chofer(a)];
    d.buscador.choferes = [apto, inactivo];
    const res = await pedir(EN_NORTE);
    // Como quedó antes de la migración: sin zona.
    await d.prisma.solicitudViaje.update({ where: { id: res.body.id }, data: { zonaId: null } });
    await d.casosFlotas.desactivarChofer({ fleetId: a }, inactivo);
    const ofertas = await d.prisma.oferta.findMany({ where: { solicitudId: res.body.id } });
    const de = (c: string) => ofertas.find((o) => o.choferId === c)!.id;

    const rechazada = await request(d.url).post(`/ofertas/${de(inactivo)}/aceptar`).set(clave()).set(await d.auth(inactivo, 'chofer')).send({});
    expect(rechazada.status).toBe(409);
    expect(rechazada.body.error.code).toBe('CHOFER_NO_APTO');

    await request(d.url).post(`/ofertas/${de(apto)}/aceptar`).set(clave()).set(await d.auth(apto, 'chofer')).send({}).expect(200);
    expect(await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: res.body.id } })).toMatchObject({
      estado: 'ASIGNADO',
      zonaId: NORTE,
      flotaId: a,
    });
  });
});
