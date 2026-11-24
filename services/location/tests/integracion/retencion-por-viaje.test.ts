import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { TramoDeViaje, TramosDeViaje } from '../../src/dominio/puertos/index.js';
import { crearPrisma } from '../../src/infra/db/cliente.js';
import { clasificarHistorial, MARGEN_TRAMO_MS, purgarHistorial } from '../../src/infra/db/retencion.js';
import { URL_BD_TEST } from '../soporte/preparar-bd.js';

/** Retención por viaje contra Postgres: 24 h los pings sin viaje, 30 días los de viaje. dispatch, falso. */
const prisma = crearPrisma(URL_BD_TEST, 5);

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE pings');
});
afterAll(async () => {
  await prisma.$disconnect();
});

const HORA = 3_600_000;
const AHORA = new Date('2026-11-26T12:00:00.000Z');
const reloj = { ahora: () => AHORA };
const atras = (ms: number) => new Date(AHORA.getTime() - ms);

/** dispatch falso: responde los tramos dados, anota cada consulta y puede fallar en una de ellas. */
class TramosFalsos implements TramosDeViaje {
  consultas: { choferes: string[]; desde: Date; hasta: Date }[] = [];
  fallarEnConsulta: number | null = null;
  constructor(public tramosConocidos: TramoDeViaje[] = []) {}

  async tramos(choferes: readonly string[], desde: Date, hasta: Date) {
    this.consultas.push({ choferes: [...choferes], desde, hasta });
    if (this.fallarEnConsulta === this.consultas.length) throw new Error('dispatch no respondió');
    const pedidos = new Set(choferes);
    return this.tramosConocidos.filter((t) => pedidos.has(t.choferId) && t.inicio <= hasta && (t.fin === null || t.fin >= desde));
  }
}

async function ping(choferId: string, recorded: Date) {
  const { id } = await prisma.ping.create({
    data: { choferId, lat: -34.6, lng: -58.4, registradoEn: recorded },
    select: { id: true },
  });
  return id;
}

const estado = async () =>
  new Map((await prisma.ping.findMany({ select: { id: true, enViaje: true } })).map((p) => [p.id, p.enViaje]));

const clasificar = (tramos: TramosDeViaje, opciones: { lote?: number; alFallar?: (e: unknown) => void } = {}) =>
  clasificarHistorial(prisma, { sinViajeMs: 24 * HORA, reloj, tramos, ...opciones })();

describe('retención por viaje', () => {
  it('después de 24 h: conserva los de viaje (también en el margen o con el tramo abierto) y borra los demás', async () => {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    const tramos = new TramosFalsos([
      { choferId: a, inicio: atras(30 * HORA), fin: atras(28 * HORA) },
      { choferId: b, inicio: atras(40 * HORA), fin: null },
    ]);
    const dentro = await ping(a, atras(29 * HORA));
    const enElMargen = await ping(a, new Date(atras(28 * HORA).getTime() + MARGEN_TRAMO_MS - 1000));
    const fuera = await ping(a, atras(27 * HORA));
    const abierto = await ping(b, atras(26 * HORA));
    const sinViaje = await ping(c, atras(25 * HORA));
    const reciente = await ping(c, atras(HORA)); // menos de 24 h: no se toca

    expect(await clasificar(tramos)).toBe(2);
    const quedan = await estado();
    expect([...quedan.keys()].sort()).toEqual([dentro, enElMargen, abierto, reciente].sort());
    expect(quedan.get(dentro)).toBe(true);
    expect(quedan.get(enElMargen)).toBe(true);
    expect(quedan.get(abierto)).toBe(true);
    expect(quedan.get(reciente)).toBeNull();
    expect(quedan.has(fuera) || quedan.has(sinViaje)).toBe(false);

    // Una segunda pasada no vuelve a consultar los ya clasificados.
    tramos.consultas = [];
    expect(await clasificar(tramos)).toBe(0);
    expect(tramos.consultas).toEqual([]);
  });

  it('un ping escrito tarde se clasifica en la próxima pasada: sin viaje se borra, de viaje se conserva', async () => {
    const [deViaje, sinViaje] = [randomUUID(), randomUUID()];
    const tramos = new TramosFalsos([{ choferId: deViaje, inicio: atras(50 * HORA), fin: atras(45 * HORA) }]);
    await ping(sinViaje, atras(30 * HORA));
    expect(await clasificar(tramos)).toBe(1);

    // Llegan tarde (historial en lotes de la optimizada): ids más altos, recorded_at viejo.
    const tardeDeViaje = await ping(deViaje, atras(47 * HORA));
    const tardeSinViaje = await ping(sinViaje, atras(48 * HORA));
    expect(await clasificar(tramos)).toBe(1);
    const quedan = await estado();
    expect(quedan.get(tardeDeViaje)).toBe(true);
    expect(quedan.has(tardeSinViaje)).toBe(false);
  });

  it('consulta en grupos de hasta 1000 choferes, con el rango ampliado por el margen, también con un solo timestamp', async () => {
    const instante = atras(30 * HORA);
    const choferes = Array.from({ length: 2500 }, () => randomUUID());
    await prisma.ping.createMany({ data: choferes.map((c) => ({ choferId: c, lat: -34.6, lng: -58.4, registradoEn: instante })) });
    // Solo el último chofer de cada grupo tiene un viaje en ese instante.
    const conViaje = [choferes[999]!, choferes[1999]!, choferes[2499]!];
    const tramos = new TramosFalsos(conViaje.map((c) => ({ choferId: c, inicio: atras(31 * HORA), fin: atras(29 * HORA) })));

    expect(await clasificar(tramos)).toBe(2497);
    expect(tramos.consultas.map((q) => q.choferes.length)).toEqual([1000, 1000, 500]);
    expect(new Set(tramos.consultas.flatMap((q) => q.choferes)).size).toBe(2500);
    for (const q of tramos.consultas) {
      expect(q.desde).toEqual(new Date(instante.getTime() - MARGEN_TRAMO_MS));
      expect(q.hasta).toEqual(new Date(instante.getTime() + MARGEN_TRAMO_MS));
    }
    const quedan = await prisma.ping.findMany({ select: { choferId: true, enViaje: true } });
    expect(quedan.map((p) => p.choferId).sort()).toEqual([...conViaje].sort());
    expect(quedan.every((p) => p.enViaje === true)).toBe(true);
  });

  it('si falla un grupo, el lote entero se conserva sin clasificar; la próxima pasada lo termina', async () => {
    const choferes = Array.from({ length: 1500 }, () => randomUUID());
    await prisma.ping.createMany({ data: choferes.map((c, i) => ({ choferId: c, lat: -34.6, lng: -58.4, registradoEn: atras(30 * HORA + i) })) });
    const tramos = new TramosFalsos();
    tramos.fallarEnConsulta = 2; // el primer grupo responde, el segundo no
    const fallas: unknown[] = [];

    expect(await clasificar(tramos, { alFallar: (e) => fallas.push(e) })).toBe(0);
    expect(fallas).toHaveLength(1);
    const despuesDeFallar = await prisma.ping.findMany({ select: { enViaje: true } });
    expect(despuesDeFallar).toHaveLength(1500);
    expect(despuesDeFallar.every((p) => p.enViaje === null)).toBe(true);

    tramos.fallarEnConsulta = null;
    expect(await clasificar(tramos)).toBe(1500);
  });

  it('la retención total igual borra los pings de viaje pasados los 30 días', async () => {
    const a = randomUUID();
    const tramos = new TramosFalsos([{ choferId: a, inicio: atras(800 * HORA), fin: atras(700 * HORA) }]);
    const viejo = await ping(a, atras(750 * HORA));
    const menosViejo = await ping(a, atras(710 * HORA));
    expect(await clasificar(tramos)).toBe(0);
    expect(await purgarHistorial(prisma, { retencionMs: 720 * HORA, reloj })()).toBe(1);
    const quedan = await estado();
    expect(quedan.has(viejo)).toBe(false);
    expect(quedan.get(menosViejo)).toBe(true);
  });
});
