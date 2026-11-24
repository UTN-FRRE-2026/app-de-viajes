import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RepositorioDespachoPrisma } from '../../src/infra/db/repositorio-prisma.js';
import { purgarOutboxPrisma } from '../../src/infra/tiempo-real/outbox-prisma.js';
import { clave, DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';

let d: Awaited<ReturnType<typeof levantarDispatch>>;

beforeAll(async () => {
  d = await levantarDispatch();
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
  d.pagos.cobrados.clear();
  d.pagos.llamadas.length = 0;
});

/** Un viaje completado: su cobro queda PENDIENTE. */
async function viajeCompletado() {
  const chofer = randomUUID();
  d.buscador.choferes = [chofer];
  const comoChofer = await d.auth(chofer, 'chofer');
  const creada = await request(d.url).post('/solicitudes').set(clave()).set(await d.auth(randomUUID(), 'pasajero')).send({ origen: ORIGEN, destino: DESTINO });
  const oferta = await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId: creada.body.id } });
  await request(d.url).post(`/ofertas/${oferta.id}/aceptar`).set(clave()).set(comoChofer).send({}).expect(200);
  for (const accion of ['en-camino', 'iniciar', 'finalizar']) {
    await request(d.url).post(`/solicitudes/${creada.body.id}/${accion}`).set(clave()).set(comoChofer).send({}).expect(200);
  }
  return creada.body.id as string;
}

describe('reclamo de los cobros pendientes (varias instancias)', () => {
  it('dos barridos a la vez eligen cobros distintos, y entre los dos, todos', async () => {
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await viajeCompletado());
    // Dos «instancias»: dos repositorios sobre la misma base.
    const [a, b] = [new RepositorioDespachoPrisma(d.prisma), new RepositorioDespachoPrisma(d.prisma)];
    const [deA, deB] = await Promise.all([a.cobrosPendientes(20), b.cobrosPendientes(20)]);
    expect(deA.filter((id) => deB.includes(id))).toEqual([]);
    expect([...deA, ...deB].sort()).toEqual([...ids].sort());
    // Ya reclamados: un tercer barrido no encuentra nada.
    expect(await a.cobrosPendientes(20)).toEqual([]);
  });

  it('un fallo suelta el reclamo: el próximo barrido lo reintenta', async () => {
    const id = await viajeCompletado();
    const repo = new RepositorioDespachoPrisma(d.prisma);
    expect(await repo.cobrosPendientes(20)).toEqual([id]);
    const cobro = await d.prisma.cobro.findUniqueOrThrow({ where: { solicitudId: id } });
    await repo.registrarFalloCobro(cobro.id, 'proveedor caído');
    expect(await repo.cobrosPendientes(20)).toEqual([id]);
  });

  it('el reclamo de una instancia que murió vence solo', async () => {
    const id = await viajeCompletado();
    const muerta = new RepositorioDespachoPrisma(d.prisma, { reclamoCobroMs: 200 });
    expect(await muerta.cobrosPendientes(20)).toEqual([id]);
    const otra = new RepositorioDespachoPrisma(d.prisma);
    expect(await otra.cobrosPendientes(20)).toEqual([]);
    await new Promise((r) => setTimeout(r, 300));
    expect(await otra.cobrosPendientes(20)).toEqual([id]);
  });

  it('dos barridos de dos instancias: el proveedor recibe un solo pedido por cobro', async () => {
    for (let i = 0; i < 4; i++) await viajeCompletado();
    d.pagos.modo = { demoraMs: 50 };
    // El barrido de esta instancia y el de otra, sobre la misma base, a la vez.
    const otra = new RepositorioDespachoPrisma(d.prisma);
    const [deOtra] = await Promise.all([otra.cobrosPendientes(20), d.casos.cobrarPendientes()]);
    // La otra instancia reclamó algunos (y no los procesó): los que procesó esta no se repiten.
    const llamados = d.pagos.llamadas.map((l) => l.clave);
    expect(new Set(llamados).size).toBe(llamados.length);
    expect(llamados.length + deOtra.length).toBe(4);
  });
});

describe('purga del outbox', () => {
  const evento = (publicadoEn: Date | null) => ({
    id: randomUUID(),
    tipo: 'RideCompleted',
    payload: {},
    publicadoEn,
    destinatarios: [randomUUID()],
  });

  it('borra solo los publicados más viejos que la retención; nunca uno sin publicar', async () => {
    const viejo = new Date(Date.now() - 3 * 3_600_000);
    await d.prisma.eventoOutbox.createMany({
      data: [evento(viejo), evento(viejo), evento(new Date()), evento(null)],
    });
    // Uno sin publicar y viejo: el relay todavía lo tiene que mandar.
    await d.prisma.eventoOutbox.create({ data: { ...evento(null), creadoEn: viejo } });

    const borrados = await purgarOutboxPrisma(d.prisma, { retencionMs: 3_600_000 })();
    expect(borrados).toBe(2);
    expect(await d.prisma.eventoOutbox.count({ where: { publicadoEn: null } })).toBe(2);
    expect(await d.prisma.eventoOutbox.count()).toBe(3);
  });

  it('por lotes: con lote 2 y 5 viejos, borra todo en una pasada', async () => {
    const viejo = new Date(Date.now() - 3 * 3_600_000);
    await d.prisma.eventoOutbox.createMany({ data: Array.from({ length: 5 }, () => evento(viejo)) });
    expect(await purgarOutboxPrisma(d.prisma, { retencionMs: 3_600_000, lote: 2 })()).toBe(5);
    expect(await d.prisma.eventoOutbox.count()).toBe(0);
  });
});
