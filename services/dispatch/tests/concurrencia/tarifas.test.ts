import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RepositorioTarifasPrisma } from '../../src/infra/db/tarifas-prisma.js';
import { clave, levantarDispatch } from '../soporte/sistema-postgres.js';

/**
 * Ediciones simultáneas de la tarifa. `dentroDelCambio` demora cada transacción después de escribir
 * y antes del COMMIT: así las ediciones se superponen de verdad, y sin el FOR UPDATE de
 * `fare_current` estas pruebas fallan (dos versiones con el mismo número, o un historial roto).
 */
let d: Awaited<ReturnType<typeof levantarDispatch>>;

beforeAll(async () => {
  d = await levantarDispatch({
    tarifas: { repo: { dentroDelCambio: () => new Promise((r) => setTimeout(r, 150)) } },
  });
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiarTarifas();
  await d.prisma.$executeRawUnsafe('TRUNCATE idempotency_keys');
});

const valores = (i: number) => ({
  bajadaCentavos: 100_000 + i,
  centavosPorKm: 50_000 + i,
  centavosPorMinuto: 10_000 + i,
  minimoCentavos: 200_000 + i,
  maxMetros: 50_000 + i,
});

const configurar = async (cuerpo: object, adminId = randomUUID(), encabezados = clave()) =>
  request(d.url).put('/admin/tarifas').set(encabezados).set(await d.auth(adminId, 'admin')).send(cuerpo);

/** El historial tiene que ser una cadena: cada cambio parte de los valores de la versión anterior. */
async function historialConsistente() {
  const versiones = await d.prisma.tarifaVersion.findMany({ orderBy: { version: 'asc' } });
  const cambios = await d.prisma.cambioTarifa.findMany({ orderBy: { version: 'asc' } });
  expect(versiones.map((v) => v.version)).toEqual(versiones.map((_, i) => i + 1));
  expect(cambios.map((c) => c.version)).toEqual(versiones.map((v) => v.version));
  const valoresDe = (v: (typeof versiones)[number]) => ({
    bajadaCentavos: v.bajadaCentavos,
    centavosPorKm: v.centavosPorKm,
    centavosPorMinuto: v.centavosPorMin,
    minimoCentavos: v.minimoCentavos,
    maxMetros: v.maxMetros,
  });
  for (const [i, c] of cambios.entries()) {
    expect(c.valoresNuevos).toEqual(valoresDe(versiones[i]!));
    expect(c.cambiadaPor).toBe(versiones[i]!.creadaPor);
    if (i === 0) expect(c).toMatchObject({ versionAnterior: null, valoresAnteriores: null });
    else expect(c).toMatchObject({ versionAnterior: i, valoresAnteriores: valoresDe(versiones[i - 1]!) });
  }
  const vigente = await d.prisma.tarifaVigenteFila.findUniqueOrThrow({ where: { id: true } });
  expect(vigente.version).toBe(versiones.at(-1)!.version);
  return versiones;
}

describe('ediciones simultáneas', () => {
  it('dos admins a la vez: las dos se guardan, en versiones seguidas, y el historial queda encadenado', async () => {
    await request(d.url).get('/admin/tarifas').set(await d.auth(randomUUID(), 'admin')).expect(200);
    const [a, b] = await Promise.all([configurar(valores(1)), configurar(valores(2))]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.version, b.body.version].sort()).toEqual(['v2', 'v3']);
    const versiones = await historialConsistente();
    expect(versiones).toHaveLength(3);
    // La vigente es la que confirmó última.
    const ultima = [a, b].find((r) => r.body.version === 'v3')!;
    expect((await request(d.url).get('/admin/tarifas').set(await d.auth(randomUUID(), 'admin'))).body).toEqual(ultima.body);
  });

  it('cinco admins a la vez: cinco versiones nuevas, sin huecos ni repetidas', async () => {
    const respuestas = await Promise.all([1, 2, 3, 4, 5].map((i) => configurar(valores(i))));
    expect(respuestas.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(respuestas.map((r) => r.body.version).sort()).toEqual(['v2', 'v3', 'v4', 'v5', 'v6']);
    expect(await historialConsistente()).toHaveLength(6);
  });

  it('20 PUT simultáneos con la misma clave: una sola versión nueva y una sola auditoría', async () => {
    const admin = randomUUID();
    const encabezados = clave();
    await request(d.url).get('/admin/tarifas').set(await d.auth(randomUUID(), 'admin')).expect(200);

    const respuestas = await Promise.all(Array.from({ length: 20 }, () => configurar(valores(7), admin, encabezados)));
    const codigos = respuestas.map((r) => r.status);
    expect(codigos.every((c) => c === 200 || c === 409)).toBe(true);
    expect(codigos.filter((c) => c === 200).length).toBeGreaterThanOrEqual(1);
    for (const r of respuestas.filter((x) => x.status === 200)) expect(r.body.version).toBe('v2');

    expect(await d.prisma.tarifaVersion.count()).toBe(2);
    expect(await d.prisma.cambioTarifa.count()).toBe(2);
    expect(await d.prisma.registroIdempotencia.count()).toBe(1);
  });
});

describe('invalidación del caché con ediciones simultáneas', () => {
  it('cada edición borra del caché la versión que reemplazó bajo el lock: no quedan v1 ni v2', async () => {
    const borradas: string[] = [];
    const s = await levantarDispatch({
      tarifas: {
        repo: { dentroDelCambio: () => new Promise((r) => setTimeout(r, 150)) },
        cache: (real) => ({
          ...real,
          borrar: (version) => {
            borradas.push(version);
            return real.borrar(version);
          },
        }),
      },
    });
    try {
      await s.limpiarTarifas();
      // Caché cargado con la v1.
      const pasajero = await s.auth(randomUUID(), 'pasajero');
      const q = { origenLat: -34.6037, origenLng: -58.3816, destinoLat: -34.5875, destinoLng: -58.4207 };
      await request(s.url).get('/tarifas/estimacion').query(q).set(pasajero).expect(200);
      expect(await s.redis.get(`${s.prefijoCache}v1`)).not.toBeNull();

      // Los dos leen la v1 antes de entrar; el segundo, al tomar el lock, ve la v2 que dejó el primero.
      const editar = async (i: number) =>
        request(s.url).put('/admin/tarifas').set(clave()).set(await s.auth(randomUUID(), 'admin')).send(valores(i));
      const [a, b] = await Promise.all([editar(1), editar(2)]);
      expect([a.status, b.status]).toEqual([200, 200]);

      expect(borradas.sort()).toEqual(['v1', 'v2']);
      expect(await s.redis.get(`${s.prefijoCache}v1`)).toBeNull();
      expect(await s.redis.get(`${s.prefijoCache}v2`)).toBeNull();
      expect(JSON.parse((await s.redis.get(`${s.prefijoCache}v3`))!)).toMatchObject({ version: 'v3' });
    } finally {
      await s.cerrar();
    }
  });
});

describe('semilla con arranques simultáneos', () => {
  it('diez dispatch que siembran a la vez con valores distintos dejan una sola versión 1', async () => {
    const repos = Array.from({ length: 10 }, () => new RepositorioTarifasPrisma(d.prisma));
    await Promise.all(repos.map((r, i) => r.sembrar(valores(i))));

    const versiones = await historialConsistente();
    expect(versiones).toHaveLength(1);
    expect(versiones[0]!.creadaPor).toBe('semilla');
  });
});
