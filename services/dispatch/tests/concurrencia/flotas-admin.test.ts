import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearCasosDeFlotas } from '../../src/dominio/casos-uso/flotas.js';
import { RepositorioFlotasPrisma } from '../../src/infra/db/flotas-prisma.js';
import { conDemorasFlotas } from '../soporte/flotas-demora.js';
import { patenteNueva, preparadorFlotas, vehiculo } from '../soporte/flotas.js';
import { levantarDispatch } from '../soporte/sistema-postgres.js';

/**
 * ADR 0012, filas 18, 19 y 21: bajar el límite de la flota contra activaciones, dos altas del mismo
 * chofer o de la misma patente, y dos reemplazos de las zonas de una misma flota. Contra Postgres real,
 * por los casos de uso: el repositorio de flotas de siempre, envuelto con demoras dentro de la
 * transacción (`conDemorasFlotas`) para que la primera tenga su escritura sin confirmar mientras llega
 * la segunda.
 */
const DEMORA_MS = 300;
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Qué operaciones esperan, con sus locks tomados. Se apagan antes de cada test. */
const demoras = { ocuparCupo: false, guardarFlota: false, insertarChofer: false, quitarZonas: false };
const demorar = (clave: keyof typeof demoras) => async () => void (demoras[clave] && (await esperar(DEMORA_MS)));

let d: Awaited<ReturnType<typeof levantarDispatch>>;
let casos: ReturnType<typeof crearCasosDeFlotas>;
let preparar: ReturnType<typeof preparadorFlotas>;

beforeAll(async () => {
  d = await levantarDispatch();
  const repo = new RepositorioFlotasPrisma(d.prisma, { trasQuitarZonas: demorar('quitarZonas') });
  casos = crearCasosDeFlotas({
    repoFlotas: conDemorasFlotas(repo, {
      ocuparCupo: demorar('ocuparCupo'),
      guardarFlota: demorar('guardarFlota'),
      insertarChofer: demorar('insertarChofer'),
    }),
    directorio: d.directorio,
    viajes: { reporteFlota: () => Promise.reject(new Error('estos tests no piden reportes')) },
  });
  // Los datos se preparan sin demoras, por los casos de uso de dispatch.
  preparar = preparadorFlotas(d.casosFlotas, d.directorio);
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  Object.assign(demoras, { ocuparCupo: false, guardarFlota: false, insertarChofer: false, quitarZonas: false });
  await d.limpiar();
  await d.sinZonaDeTest();
});

/** Arranca `primero`, espera a que tome sus locks y recién ahí arranca `segundo`. Mide cuánto tardó el segundo. */
async function superponer<A, B>(primero: () => Promise<A>, segundo: () => Promise<B>) {
  const p1 = primero();
  await esperar(DEMORA_MS / 3);
  // performance.now() y no Date.now(): el reloj de pared puede saltar (lo vimos en WSL).
  const inicio = performance.now();
  let msSegundo = 0;
  const p2 = segundo().finally(() => {
    msSegundo = performance.now() - inicio;
  });
  const [r1, r2] = await Promise.allSettled([p1, p2]);
  return { primero: r1, segundo: r2, msSegundo };
}

/** El código del error de dominio con el que terminó, o 'ok'. */
const resultado = (r: PromiseSettledResult<unknown>) =>
  r.status === 'fulfilled' ? 'ok' : ((r.reason as { codigo?: string }).codigo ?? String(r.reason));

/** Lo que dice Postgres: el contador, el límite y los choferes activos de verdad. */
async function enPostgres(flotaId: string) {
  const [fila] = await d.prisma.$queryRaw<{ activos: bigint; contador: number; maximo: number }[]>`
    SELECT (SELECT count(*) FROM drivers WHERE fleet_id = ${flotaId}::uuid AND active) AS activos,
           active_count AS contador, max_active AS maximo
    FROM fleets WHERE id = ${flotaId}::uuid`;
  return { activos: Number(fila?.activos), contador: fila?.contador, maximo: fila?.maximo };
}

describe('bajar el límite de la flota contra activaciones (fila 18)', () => {
  /** Flota con límite 5, 3 activos y 2 habilitados sin activar. */
  async function flotaConTresActivos() {
    const flota = await preparar.flota(5);
    const choferes = await preparar.choferes(flota.id, 5);
    for (const c of choferes.slice(0, 3)) await d.casosFlotas.activarChofer({ fleetId: flota.id }, c);
    return { flota, inactivos: choferes.slice(3) };
  }
  const bajarA3 = (flotaId: string) => () => casos.guardarFlota({ id: flotaId, nombre: 'Flota', maxActivos: 3 });

  // Lo que lo hace pasar: el `ON CONFLICT DO UPDATE … WHERE active_count <= EXCLUDED.max_active` de
  // `guardarFlota` espera el lock de la fila que tomó el UPDATE condicional de la activación, y al
  // confirmar ésta lo reevalúa con el contador nuevo (4 > 3): no cambia nada. Sin ese WHERE, el límite
  // quedaría en 3 con 4 activos (lo frenaría el CHECK con un error 500, no con LIMITE_MENOR_QUE_ACTIVOS).
  it('la activación primero (cupo ocupado sin confirmar): bajar el límite espera y da LIMITE_MENOR_QUE_ACTIVOS', async () => {
    const { flota, inactivos } = await flotaConTresActivos();
    demoras.ocuparCupo = true;

    const { primero, segundo, msSegundo } = await superponer(
      () => casos.activarChofer({ fleetId: flota.id }, inactivos[0]!),
      bajarA3(flota.id),
    );

    expect(resultado(primero)).toBe('ok');
    expect(resultado(segundo)).toBe('LIMITE_MENOR_QUE_ACTIVOS');
    expect(msSegundo).toBeGreaterThan(DEMORA_MS / 2);
    expect(await enPostgres(flota.id)).toEqual({ activos: 4, contador: 4, maximo: 5 });
  });

  // Lo que lo hace pasar: el UPDATE condicional de `ocuparCupo` (`active_count < max_active`) espera el
  // lock de la fila que tomó el upsert del límite y lo reevalúa con el límite nuevo (3 < 3, no).
  it('bajar el límite primero (sin confirmar): la activación espera y da LIMITE_FLOTA_ALCANZADO', async () => {
    const { flota, inactivos } = await flotaConTresActivos();
    demoras.guardarFlota = true;

    const { primero, segundo, msSegundo } = await superponer(bajarA3(flota.id), () =>
      casos.activarChofer({ fleetId: flota.id }, inactivos[0]!),
    );

    expect(resultado(primero)).toBe('ok');
    expect(resultado(segundo)).toBe('LIMITE_FLOTA_ALCANZADO');
    expect(msSegundo).toBeGreaterThan(DEMORA_MS / 2);
    expect(await enPostgres(flota.id)).toEqual({ activos: 3, contador: 3, maximo: 3 });
    // El chofer no quedó activo: la transacción entera se deshizo.
    expect((await d.prisma.choferFlota.findUniqueOrThrow({ where: { id: inactivos[0]! } })).activo).toBe(false);
  });

  it('dos activaciones y una baja del límite a la vez (10 repeticiones): nunca más activos que el límite', async () => {
    demoras.ocuparCupo = true;
    for (let i = 0; i < 10; i++) {
      const { flota, inactivos } = await flotaConTresActivos();
      const resultados = await Promise.allSettled([
        casos.activarChofer({ fleetId: flota.id }, inactivos[0]!),
        bajarA3(flota.id)(),
        casos.activarChofer({ fleetId: flota.id }, inactivos[1]!),
      ]);
      const codigos = resultados.map(resultado);
      for (const c of codigos) expect(['ok', 'LIMITE_MENOR_QUE_ACTIVOS', 'LIMITE_FLOTA_ALCANZADO']).toContain(c);

      const estado = await enPostgres(flota.id);
      expect(estado.contador).toBe(estado.activos);
      expect(estado.activos).toBeLessThanOrEqual(estado.maximo!);
      const activaciones = [codigos[0], codigos[2]].filter((c) => c === 'ok').length;
      expect(estado.activos).toBe(3 + activaciones);
      // O bajó el límite y no entró nadie, o entró alguien y el límite siguió en 5.
      expect(estado.maximo).toBe(codigos[1] === 'ok' ? 3 : 5);
      if (codigos[1] === 'ok') expect(activaciones).toBe(0);
    }
  });
});

describe('dos altas del mismo chofer o de la misma patente (fila 19)', () => {
  // Lo que lo hace pasar: la PK `drivers.id` y el `UNIQUE vehicle_plate`, con `INSERT … ON CONFLICT DO
  // NOTHING`. La segunda inserción espera a que la primera (sin confirmar) termine, no inserta nada y la
  // relectura (READ COMMITTED, otra instantánea) encuentra la fila: CHOFER_YA_REGISTRADO o
  // PATENTE_YA_REGISTRADA, no un error 500 de la base.
  it('10 altas simultáneas del mismo chofer en dos flotas: entra una sola, las demás CHOFER_YA_REGISTRADO', async () => {
    const [a, b] = [await preparar.flota(5), await preparar.flota(5)];
    const chofer = d.directorio.registrar(randomUUID(), 'chofer');
    demoras.insertarChofer = true;

    const resultados = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => casos.altaChofer({ fleetId: i % 2 ? a.id : b.id }, { choferId: chofer, vehiculo: vehiculo() })),
    );

    const codigos = resultados.map(resultado);
    expect(codigos.filter((c) => c === 'ok')).toHaveLength(1);
    expect(codigos.filter((c) => c === 'CHOFER_YA_REGISTRADO')).toHaveLength(9);
    // En la base: una sola fila del chofer, en la flota del alta que ganó.
    const filas = await d.prisma.choferFlota.findMany({ where: { id: chofer } });
    expect(filas).toHaveLength(1);
    const ganadora = codigos.indexOf('ok');
    expect(filas[0]!.flotaId).toBe(ganadora % 2 ? a.id : b.id);
  });

  it('dos choferes con la misma patente a la vez: entra uno, el otro PATENTE_YA_REGISTRADA', async () => {
    const flota = await preparar.flota(5);
    const [uno, otro] = [d.directorio.registrar(randomUUID(), 'chofer'), d.directorio.registrar(randomUUID(), 'chofer')];
    const patente = patenteNueva();
    demoras.insertarChofer = true;

    const { primero, segundo, msSegundo } = await superponer(
      () => casos.altaChofer({ fleetId: flota.id }, { choferId: uno, vehiculo: { ...vehiculo(), patente } }),
      () => casos.altaChofer({ fleetId: flota.id }, { choferId: otro, vehiculo: { ...vehiculo(), patente } }),
    );

    expect(resultado(primero)).toBe('ok');
    expect(resultado(segundo)).toBe('PATENTE_YA_REGISTRADA');
    // Esperó a que la primera confirmara (su fila sin confirmar tenía la patente).
    expect(msSegundo).toBeGreaterThan(DEMORA_MS / 2);
    expect(await d.prisma.choferFlota.findMany({ where: { patente }, select: { id: true } })).toEqual([{ id: uno }]);
    expect(await d.prisma.choferFlota.count({ where: { id: otro } })).toBe(0);
  });
});

describe('dos reemplazos de las zonas de la misma flota (fila 21)', () => {
  /** Tres cuadrados separados: no se superponen. */
  const cuadrado = (oeste: number): [number, number][] => [
    [oeste, -34.6],
    [oeste + 0.09, -34.6],
    [oeste + 0.09, -34.5],
    [oeste, -34.5],
    [oeste, -34.6],
  ];
  const Z1 = randomUUID();
  const Z2 = randomUUID();
  const Z3 = randomUUID();

  // Lo que lo hace pasar: el `FOR NO KEY UPDATE` de la fila de la flota en `reemplazarZonasDeFlota`. El
  // segundo reemplazo espera al primero entero; su DELETE (otra sentencia, otra instantánea) ya ve la
  // zona que insertó el primero y la borra. Sin ese lock, el segundo DELETE no ve la inserción sin
  // confirmar del primero, y la flota queda con las zonas de los dos pedidos mezcladas.
  it('el segundo espera al primero: la flota queda con las zonas de uno solo, nunca mezcladas', async () => {
    for (const [id, oeste] of [
      [Z1, -58.5],
      [Z2, -58.4],
      [Z3, -58.3],
    ] as const) {
      await d.casosFlotas.guardarZona({ id, nombre: `Zona ${oeste}`, anillo: cuadrado(oeste) });
    }
    const flota = await preparar.flota(5);
    await d.casosFlotas.zonasDeFlota(flota.id, [Z1]);
    demoras.quitarZonas = true;

    const { primero, segundo, msSegundo } = await superponer(
      () => casos.zonasDeFlota(flota.id, [Z2]),
      () => casos.zonasDeFlota(flota.id, [Z3]),
    );

    expect(primero).toMatchObject({ status: 'fulfilled', value: { zonas: [Z2] } });
    expect(segundo).toMatchObject({ status: 'fulfilled', value: { zonas: [Z3] } });
    // Esperó el lock de la flota: la demora del primero, con la zona vieja borrada y la nueva sin insertar.
    expect(msSegundo).toBeGreaterThan(DEMORA_MS / 2);
    // En la base: exactamente lo que pidió el último en confirmar.
    const zonas = await d.prisma.flotaZona.findMany({ where: { flotaId: flota.id }, select: { zonaId: true } });
    expect(zonas.map((z) => z.zonaId)).toEqual([Z3]);
  });
});
