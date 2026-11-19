import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { CoordenadaInvalida } from '../../src/dominio/errores/index.js';
import type { RepositorioUbicaciones } from '../../src/dominio/puertos/index.js';
import { alNorte, OBELISCO, sistemaCon, VIGENCIA_MS } from './memoria.js';

/**
 * Las mismas reglas para cualquier estrategia: hoy memoria e ingenua (Postgres); en el PR de la
 * tarea pesada, también la optimizada. Si una estrategia nueva no las cumple, no entra.
 */
export function probarCasosDeUbicacion(nombre: string, crearRepo: () => Promise<RepositorioUbicaciones>) {
  describe(`casos de uso de ubicación (${nombre})`, () => {
    let s: ReturnType<typeof sistemaCon>;
    beforeEach(async () => {
      s = sistemaCon(await crearRepo());
    });

    const buscar = (extra: Partial<{ radioMetros: number; limite: number }> = {}) =>
      s.casos.buscarCandidatos({ origen: OBELISCO, radioMetros: 5000, limite: 10, ...extra });

    it('un chofer que informa su posición aparece como candidato, con distancia entera', async () => {
      const chofer = randomUUID();
      await s.casos.registrarUbicacion({ choferId: chofer, ...alNorte(412) });
      const [c] = await buscar();
      expect(c).toMatchObject({ choferId: chofer, actualizadaEn: s.reloj.ahora() });
      expect(Number.isInteger(c?.distanciaMetros)).toBe(true);
      expect(c?.distanciaMetros).toBeGreaterThanOrEqual(411);
      expect(c?.distanciaMetros).toBeLessThanOrEqual(413);
    });

    it('ordena por distancia y respeta radio y límite', async () => {
      const [cerca, medio, lejos, fuera] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      await s.casos.registrarUbicacion({ choferId: lejos, ...alNorte(4000) });
      await s.casos.registrarUbicacion({ choferId: fuera, ...alNorte(9000) });
      await s.casos.registrarUbicacion({ choferId: cerca, ...alNorte(200) });
      await s.casos.registrarUbicacion({ choferId: medio, ...alNorte(1500) });

      expect((await buscar()).map((c) => c.choferId)).toEqual([cerca, medio, lejos]);
      expect((await buscar({ limite: 2 })).map((c) => c.choferId)).toEqual([cerca, medio]);
      expect((await buscar({ radioMetros: 1000 })).map((c) => c.choferId)).toEqual([cerca]);
    });

    it('cuenta solo la última posición de cada chofer', async () => {
      const chofer = randomUUID();
      await s.casos.registrarUbicacion({ choferId: chofer, ...alNorte(300) });
      s.reloj.avanzar(2000);
      await s.casos.registrarUbicacion({ choferId: chofer, ...alNorte(4500) });

      const candidatos = await buscar();
      expect(candidatos).toHaveLength(1);
      expect(candidatos[0]?.distanciaMetros).toBeGreaterThan(4000);
      // Si se fue del radio, ya no aparece aunque antes estuviera cerca.
      expect(await buscar({ radioMetros: 1000 })).toEqual([]);
    });

    it('un chofer que dejó de reportar desaparece al vencer su posición (fantasma)', async () => {
      const chofer = randomUUID();
      await s.casos.registrarUbicacion({ choferId: chofer, ...alNorte(100) });
      s.reloj.avanzar(VIGENCIA_MS);
      expect(await buscar()).toHaveLength(1);
      s.reloj.avanzar(1);
      expect(await buscar()).toEqual([]);
    });

    it('sin choferes cerca devuelve una lista vacía, no un error', async () => {
      expect(await buscar()).toEqual([]);
    });

    it('una coordenada imposible no se guarda', async () => {
      await expect(s.casos.registrarUbicacion({ choferId: randomUUID(), lat: 95, lng: 0 })).rejects.toBeInstanceOf(CoordenadaInvalida);
      expect(await buscar({ radioMetros: 50_000 })).toEqual([]);
    });
  });
}
