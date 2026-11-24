import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { preparadorFlotas } from '../soporte/flotas.js';
import { clave, DESTINO, levantarDispatch } from '../soporte/sistema-postgres.js';

/**
 * La carrera entre aceptar una oferta y que la flota cambie las reglas a mitad de camino: el admin de
 * flota desactiva al chofer, o el admin le quita la zona a la flota. Con una demora dentro de cada
 * transacción (con sus locks tomados), las dos se superponen de verdad en Postgres:
 * - si la otra va primero, la aceptación espera su lock, ve el cambio y responde 409 CHOFER_NO_APTO;
 * - si la aceptación va primero, la otra espera a que confirme: el viaje queda asignado (con la flota).
 * Sin el FOR SHARE del chofer o de la zona de la flota, estos tests fallan (comprobado).
 */
const DEMORA_MS = 400;
const demoras = { chofer: false, zonas: false, aceptar: false };
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

let d: Awaited<ReturnType<typeof levantarDispatch>>;
let preparar: ReturnType<typeof preparadorFlotas>;

beforeAll(async () => {
  d = await levantarDispatch({
    flotas: {
      trasBloquearChofer: async () => void (demoras.chofer && (await esperar(DEMORA_MS))),
      trasQuitarZonas: async () => void (demoras.zonas && (await esperar(DEMORA_MS))),
    },
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
  Object.assign(demoras, { chofer: false, zonas: false, aceptar: false });
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
const desactivar = async () =>
  request(d.url).post(`/flota/choferes/${chofer}/desactivar`).set(clave()).set(await d.authFlota(randomUUID(), flota)).send({});
const quitarZona = async () =>
  request(d.url).put(`/admin/flotas/${flota}/zonas`).set(clave()).set(await d.auth(randomUUID(), 'admin')).send({ zonas: [] });
const solicitud = () => d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: solicitudId } });

/** Arranca `primero`, espera a que tome sus locks y recién ahí arranca `segundo`. Mide cuánto tardó el segundo. */
async function superponer<A, B>(primero: () => Promise<A>, segundo: () => Promise<B>) {
  const p1 = primero();
  await esperar(DEMORA_MS / 4);
  const inicio = Date.now();
  const p2 = segundo().then((r) => ({ r, ms: Date.now() - inicio }));
  const [r1, r2] = await Promise.all([p1, p2]);
  return { primero: r1, segundo: r2.r, msSegundo: r2.ms };
}

describe('aceptar contra desactivar al chofer', () => {
  it('desactivar primero: la aceptación espera el lock del chofer, lo ve inactivo y da 409 CHOFER_NO_APTO', async () => {
    demoras.chofer = true;
    const { primero, segundo, msSegundo } = await superponer(desactivar, aceptar);
    expect(primero.status).toBe(200);
    expect(segundo.status).toBe(409);
    expect(segundo.body.error.code).toBe('CHOFER_NO_APTO');
    // Esperó a que desactivar confirmara (su demora estaba dentro de la transacción, con el lock).
    expect(msSegundo).toBeGreaterThan(DEMORA_MS / 2);
    expect(await solicitud()).toMatchObject({ estado: 'BUSCANDO', choferId: null, flotaId: null });
    expect(await d.prisma.asignacionActiva.count()).toBe(0);
  });

  it('aceptar primero: desactivar espera a que confirme; el viaje queda asignado con la flota y el cupo se libera', async () => {
    demoras.aceptar = true;
    const { primero, segundo, msSegundo } = await superponer(aceptar, desactivar);
    expect(primero.status).toBe(200);
    expect(segundo.status).toBe(200);
    expect(msSegundo).toBeGreaterThan(DEMORA_MS / 2);
    expect(await solicitud()).toMatchObject({ estado: 'ASIGNADO', choferId: chofer, flotaId: flota, zonaId: ZONA });
    expect(await d.prisma.choferFlota.findUniqueOrThrow({ where: { id: chofer } })).toMatchObject({ activo: false, disponible: false });
    expect((await d.prisma.flota.findUniqueOrThrow({ where: { id: flota } })).activos).toBe(0);
  });
});

describe('aceptar contra quitarle la zona a la flota', () => {
  it('quitar la zona primero: la aceptación espera, ya no la encuentra y da 409 CHOFER_NO_APTO', async () => {
    demoras.zonas = true;
    const { primero, segundo, msSegundo } = await superponer(quitarZona, aceptar);
    expect(primero.status).toBe(200);
    expect(segundo.status).toBe(409);
    expect(segundo.body.error.code).toBe('CHOFER_NO_APTO');
    expect(msSegundo).toBeGreaterThan(DEMORA_MS / 2);
    expect((await solicitud()).estado).toBe('BUSCANDO');
  });

  it('aceptar primero: quitar la zona espera a que confirme; el viaje sigue y la flota queda sin la zona', async () => {
    demoras.aceptar = true;
    const { primero, segundo, msSegundo } = await superponer(aceptar, quitarZona);
    expect(primero.status).toBe(200);
    expect(segundo.status).toBe(200);
    expect(msSegundo).toBeGreaterThan(DEMORA_MS / 2);
    expect(await solicitud()).toMatchObject({ estado: 'ASIGNADO', flotaId: flota });
    expect(await d.prisma.flotaZona.count({ where: { flotaId: flota } })).toBe(0);
  });
});
