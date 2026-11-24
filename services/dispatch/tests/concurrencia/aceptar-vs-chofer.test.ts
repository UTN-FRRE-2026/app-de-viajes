import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { preparadorFlotas } from '../soporte/flotas.js';
import { clave, DESTINO, levantarDispatch } from '../soporte/sistema-postgres.js';

/**
 * ADR 0012, fila 8: aceptar una oferta contra que el admin de la plataforma deshabilite al chofer, o
 * contra que el chofer se ponga «no disponible». Igual que aceptar-vs-flota.test.ts, con una demora
 * dentro de cada transacción (con sus locks tomados) para que se superpongan de verdad.
 *
 * Lo que lo hace pasar: la aceptación toma `FOR SHARE` de la fila del chofer con
 * `approved AND active AND available` en el WHERE (`choferAptoParaAceptar`), y deshabilitar y cambiar la
 * disponibilidad toman `FOR UPDATE` de esa misma fila (`obtenerChoferParaActualizar`):
 * - si la otra va primero, la aceptación espera, Postgres reevalúa el WHERE con la fila nueva y da 0
 *   filas → 409 CHOFER_NO_APTO;
 * - si la aceptación va primero, la otra espera a que confirme: el viaje quedó asignado a un chofer que
 *   era apto en ese momento.
 * Sin el FOR SHARE, la aceptación leería la fila vieja (sin esperar) y asignaría el viaje a un chofer ya
 * deshabilitado o no disponible.
 */
const DEMORA_MS = 400;
const demoras = { chofer: false, aceptar: false };
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

let d: Awaited<ReturnType<typeof levantarDispatch>>;
let preparar: ReturnType<typeof preparadorFlotas>;

beforeAll(async () => {
  d = await levantarDispatch({
    flotas: { trasBloquearChofer: async () => void (demoras.chofer && (await esperar(DEMORA_MS))) },
    despacho: { trasValidarChofer: async () => void (demoras.aceptar && (await esperar(DEMORA_MS))) },
  });
  preparar = preparadorFlotas(d.casosFlotas, d.directorio);
});
afterAll(async () => {
  await d.cerrar();
});

const ZONA = randomUUID();
const ORIGEN = { lat: -34.55, lng: -58.45 };
let flota: string;
let chofer: string;
let solicitudId: string;
let ofertaId: string;

beforeEach(async () => {
  Object.assign(demoras, { chofer: false, aceptar: false });
  await d.limpiar();
  await d.sinZonaDeTest();
  await d.casosFlotas.guardarZona({
    id: ZONA,
    nombre: 'Norte',
    anillo: [
      [-58.5, -34.6],
      [-58.4, -34.6],
      [-58.4, -34.5],
      [-58.5, -34.5],
      [-58.5, -34.6],
    ],
  });
  flota = (await preparar.flota(5)).id;
  await d.casosFlotas.zonasDeFlota(flota, [ZONA]);
  chofer = await preparar.chofer(flota);
  await d.casosFlotas.activarChofer({ fleetId: flota }, chofer);
  await d.casosFlotas.cambiarDisponibilidad(chofer, true);
  d.buscador.choferes = [chofer];
  const res = await request(d.url)
    .post('/solicitudes')
    .set(clave())
    .set(await d.auth(randomUUID(), 'pasajero'))
    .send({ origen: ORIGEN, destino: DESTINO });
  solicitudId = res.body.id;
  ofertaId = (await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId } })).id;
});

const aceptar = async () => request(d.url).post(`/ofertas/${ofertaId}/aceptar`).set(clave()).set(await d.auth(chofer, 'chofer')).send({});
const deshabilitar = async () =>
  request(d.url).post(`/admin/choferes/${chofer}/deshabilitar`).set(clave()).set(await d.auth(randomUUID(), 'admin')).send({});
const noDisponible = async () =>
  request(d.url).put('/chofer/disponibilidad').set(clave()).set(await d.auth(chofer, 'chofer')).send({ disponible: false });
const solicitud = () => d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: solicitudId } });
const filaChofer = () => d.prisma.choferFlota.findUniqueOrThrow({ where: { id: chofer } });

/** Arranca `primero`, espera a que tome sus locks y recién ahí arranca `segundo`. Mide cuánto tardó el segundo. */
async function superponer<A, B>(primero: () => Promise<A>, segundo: () => Promise<B>) {
  const p1 = primero();
  await esperar(DEMORA_MS / 4);
  const inicio = performance.now();
  const p2 = segundo().then((r) => ({ r, ms: performance.now() - inicio }));
  const [r1, r2] = await Promise.all([p1, p2]);
  return { primero: r1, segundo: r2.r, msSegundo: r2.ms };
}

describe('aceptar contra deshabilitar al chofer (admin)', () => {
  it('deshabilitar primero: la aceptación espera el lock del chofer, lo ve deshabilitado y da 409 CHOFER_NO_APTO', async () => {
    demoras.chofer = true;
    const { primero, segundo, msSegundo } = await superponer(deshabilitar, aceptar);
    expect(primero.status).toBe(200);
    expect(segundo.status).toBe(409);
    expect(segundo.body.error.code).toBe('CHOFER_NO_APTO');
    expect(msSegundo).toBeGreaterThan(DEMORA_MS / 2);
    // En la base: ningún viaje para un chofer deshabilitado, y su cupo liberado.
    expect(await solicitud()).toMatchObject({ estado: 'BUSCANDO', choferId: null, flotaId: null });
    expect(await d.prisma.asignacionActiva.count()).toBe(0);
    expect(await filaChofer()).toMatchObject({ habilitado: false, activo: false, disponible: false });
    expect((await d.prisma.flota.findUniqueOrThrow({ where: { id: flota } })).activos).toBe(0);
  });

  it('aceptar primero: deshabilitar espera a que confirme; el viaje queda asignado y el chofer, deshabilitado', async () => {
    demoras.aceptar = true;
    const { primero, segundo, msSegundo } = await superponer(aceptar, deshabilitar);
    expect(primero.status).toBe(200);
    expect(segundo.status).toBe(200);
    // Esperó el FOR SHARE de la aceptación: el chofer era apto cuando se le asignó el viaje.
    expect(msSegundo).toBeGreaterThan(DEMORA_MS / 2);
    expect(await solicitud()).toMatchObject({ estado: 'ASIGNADO', choferId: chofer, flotaId: flota });
    expect(await d.prisma.asignacionActiva.count({ where: { choferId: chofer } })).toBe(1);
    expect(await filaChofer()).toMatchObject({ habilitado: false, activo: false, disponible: false });
    expect((await d.prisma.flota.findUniqueOrThrow({ where: { id: flota } })).activos).toBe(0);
  });
});

describe('aceptar contra «no disponible» (el chofer)', () => {
  it('no disponible primero: la aceptación espera, lo ve no disponible y da 409 CHOFER_NO_APTO', async () => {
    demoras.chofer = true;
    const { primero, segundo, msSegundo } = await superponer(noDisponible, aceptar);
    expect(primero.status).toBe(200);
    expect(segundo.status).toBe(409);
    expect(segundo.body.error.code).toBe('CHOFER_NO_APTO');
    expect(msSegundo).toBeGreaterThan(DEMORA_MS / 2);
    expect(await solicitud()).toMatchObject({ estado: 'BUSCANDO', choferId: null });
    expect(await d.prisma.asignacionActiva.count()).toBe(0);
    expect(await filaChofer()).toMatchObject({ habilitado: true, activo: true, disponible: false });
  });

  it('aceptar primero: el cambio de disponibilidad espera a que confirme; el viaje queda asignado', async () => {
    demoras.aceptar = true;
    const { primero, segundo, msSegundo } = await superponer(aceptar, noDisponible);
    expect(primero.status).toBe(200);
    expect(segundo.status).toBe(200);
    expect(msSegundo).toBeGreaterThan(DEMORA_MS / 2);
    expect(await solicitud()).toMatchObject({ estado: 'ASIGNADO', choferId: chofer, flotaId: flota });
    expect(await d.prisma.asignacionActiva.count({ where: { choferId: chofer } })).toBe(1);
    expect(await filaChofer()).toMatchObject({ disponible: false });
  });
});
