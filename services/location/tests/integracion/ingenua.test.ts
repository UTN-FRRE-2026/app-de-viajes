import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPrisma } from '../../src/infra/db/cliente.js';
import { RepositorioUbicacionesIngenuo } from '../../src/infra/db/repositorio-ingenuo.js';
import { probarCasosDeUbicacion } from '../soporte/casos-compartidos.js';
import { alNorte, sistemaCon } from '../soporte/memoria.js';
import { URL_BD_TEST } from '../soporte/preparar-bd.js';

const prisma = crearPrisma(URL_BD_TEST, 5);

beforeAll(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE pings');
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE pings');
});
afterAll(async () => {
  await prisma.$disconnect();
});

// Mismas reglas que en memoria, ahora contra Postgres.
probarCasosDeUbicacion('ingenua, Postgres', async () => new RepositorioUbicacionesIngenuo(prisma));

describe('estrategia ingenua: lo que se va a medir', () => {
  it('cada ping es un INSERT: el historial guarda todos', async () => {
    const s = sistemaCon(new RepositorioUbicacionesIngenuo(prisma));
    const chofer = randomUUID();
    for (let i = 0; i < 5; i++) {
      await s.casos.registrarUbicacion({ choferId: chofer, ...alNorte(100 * i) });
      s.reloj.avanzar(2000);
    }
    expect(await prisma.ping.count({ where: { choferId: chofer } })).toBe(5);
  });

  it('a la misma hora, gana la última posición insertada', async () => {
    const s = sistemaCon(new RepositorioUbicacionesIngenuo(prisma));
    const chofer = randomUUID();
    await s.casos.registrarUbicacion({ choferId: chofer, ...alNorte(100) });
    await s.casos.registrarUbicacion({ choferId: chofer, ...alNorte(2500) });
    const [c] = await s.casos.buscarCandidatos({ origen: alNorte(0), radioMetros: 5000, limite: 10 });
    expect(c?.distanciaMetros).toBeGreaterThan(2400);
  });

  it('la base rechaza coordenadas imposibles aunque algún camino no valide', async () => {
    await expect(
      prisma.ping.create({ data: { choferId: randomUUID(), lat: 120, lng: 0, registradoEn: new Date() } }),
    ).rejects.toThrow();
  });
});
