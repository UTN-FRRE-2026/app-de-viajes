import { randomUUID } from 'node:crypto';
import type { Logger } from '@viajes/platform';
import { describe, expect, it } from 'vitest';
import { crearCasosDeUso } from '../../src/dominio/casos-uso/index.js';
import type { Ping } from '../../src/dominio/entidades/index.js';
import type { PublicadorPosiciones, ResultadoPublicacion } from '../../src/dominio/puertos/index.js';
import { RepositorioUbicacionesMemoria } from '../../src/infra/memoria/repositorio-memoria.js';
import { registroPublicacion } from '../../src/infra/redis/publicador-posiciones.js';
import { alNorte, OBELISCO, RelojFalso, VIGENCIA_MS } from '../soporte/memoria.js';

/** Publicador en memoria con la misma regla que el de Redis: no publica algo más viejo que lo último. */
class PublicadorFalso implements PublicadorPosiciones {
  readonly publicadas: Ping[] = [];
  falla?: Error;
  async publicar(ping: Ping) {
    if (this.falla) throw this.falla;
    const ultima = this.publicadas.at(-1);
    if (ultima && ping.registradoEn < ultima.registradoEn) return 'atrasada' as const;
    this.publicadas.push(ping);
    return 'publicada' as const;
  }
}

function sistema() {
  const repo = new RepositorioUbicacionesMemoria();
  const reloj = new RelojFalso();
  const publicador = new PublicadorFalso();
  const resultados: Array<[ResultadoPublicacion, unknown?]> = [];
  const casos = crearCasosDeUso({
    repo,
    reloj,
    vigenciaMs: VIGENCIA_MS,
    publicador,
    alPublicar: (r, err) => resultados.push(err === undefined ? [r] : [r, err]),
  });
  return { repo, reloj, publicador, resultados, casos };
}

describe('publicación de la posición en vivo', () => {
  it('publica después de guardar, con el chofer, la posición y la hora del ping', async () => {
    const s = sistema();
    const chofer = randomUUID();
    await s.casos.registrarUbicacion({ choferId: chofer, ...alNorte(300) });
    expect(s.publicador.publicadas).toEqual([{ choferId: chofer, posicion: alNorte(300), registradoEn: s.reloj.ahora() }]);
    expect(s.repo.ultimas.get(chofer)?.registradoEn).toEqual(s.reloj.ahora());
    expect(s.resultados).toEqual([['publicada']]);
  });

  it('si guardar falla, no se publica nada', async () => {
    const s = sistema();
    s.repo.guardar = () => Promise.reject(new Error('Redis caído'));
    await expect(s.casos.registrarUbicacion({ choferId: randomUUID(), ...OBELISCO })).rejects.toThrow('Redis caído');
    expect(s.publicador.publicadas).toEqual([]);
    expect(s.resultados).toEqual([]);
  });

  it('si publicar falla, el ping igual queda registrado y se informa el error', async () => {
    const s = sistema();
    const chofer = randomUUID();
    const falla = new Error('timeout');
    s.publicador.falla = falla;
    await expect(s.casos.registrarUbicacion({ choferId: chofer, ...OBELISCO })).resolves.toBeUndefined();
    expect(s.repo.ultimas.get(chofer)).toBeDefined();
    expect(s.resultados).toEqual([['error', falla]]);
  });

  it('un ping que venció mientras se guardaba no se publica (sería un fantasma)', async () => {
    const s = sistema();
    const guardar = s.repo.guardar.bind(s.repo);
    s.repo.guardar = async (ping) => {
      s.reloj.avanzar(VIGENCIA_MS + 1);
      await guardar(ping);
    };
    await s.casos.registrarUbicacion({ choferId: randomUUID(), ...OBELISCO });
    expect(s.publicador.publicadas).toEqual([]);
    expect(s.resultados).toEqual([['vencida']]);
  });

  it('justo en el límite de la vigencia todavía se publica (la misma regla que la búsqueda)', async () => {
    const s = sistema();
    const guardar = s.repo.guardar.bind(s.repo);
    s.repo.guardar = async (ping) => {
      s.reloj.avanzar(VIGENCIA_MS);
      await guardar(ping);
    };
    await s.casos.registrarUbicacion({ choferId: randomUUID(), ...OBELISCO });
    expect(s.resultados).toEqual([['publicada']]);
  });

  it('sin publicador (sin Redis), el ping se registra igual', async () => {
    const repo = new RepositorioUbicacionesMemoria();
    const casos = crearCasosDeUso({ repo, reloj: new RelojFalso(), vigenciaMs: VIGENCIA_MS });
    const chofer = randomUUID();
    await casos.registrarUbicacion({ choferId: chofer, ...OBELISCO });
    expect(repo.ultimas.get(chofer)).toBeDefined();
  });
});

describe('registro de las publicaciones', () => {
  function loggerFalso() {
    const avisos: Array<Record<string, unknown>> = [];
    const logger = { warn: (obj: Record<string, unknown>) => avisos.push(obj) } as unknown as Logger;
    return { logger, avisos };
  }

  it('cuenta cada resultado y avisa de los errores como mucho una vez por minuto, con cuántos hubo', () => {
    const { logger, avisos } = loggerFalso();
    const contados: ResultadoPublicacion[] = [];
    let ahora = 0;
    const registrar = registroPublicacion(logger, (r) => contados.push(r), () => ahora);

    registrar('publicada');
    registrar('error', new Error('a'));
    for (let i = 0; i < 99; i++) registrar('error', new Error('b'));
    ahora = 59_999;
    registrar('error', new Error('c'));
    expect(avisos).toEqual([{ err: 'a', fallidas: 1 }]);

    ahora = 60_000;
    registrar('error', new Error('d'));
    expect(avisos).toEqual([
      { err: 'a', fallidas: 1 },
      { err: 'd', fallidas: 101 },
    ]);
    expect(contados.filter((r) => r === 'error')).toHaveLength(102);
    expect(contados[0]).toBe('publicada');
  });
});
