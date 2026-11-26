import { crearLogger } from '@viajes/platform';
import { describe, expect, it } from 'vitest';
import { MapasConRespaldo } from '../../src/infra/externos/mapas-con-respaldo.js';
import { MapasOsrm } from '../../src/infra/externos/mapas-osrm.js';
import { MapasSimulado } from '../../src/infra/externos/mapas-simulado.js';
import { DESTINO, ORIGEN } from '../soporte/memoria.js';

const silencioso = crearLogger('rutas-test', 'silent');

/** Una respuesta de OSRM con la forma real: geometría GeoJSON en [lng, lat]. */
const cuerpoOsrm = (extra: Record<string, unknown> = {}) => ({
  code: 'Ok',
  routes: [
    {
      distance: 4612.6,
      duration: 655.4,
      geometry: {
        type: 'LineString',
        coordinates: [
          [ORIGEN.lng, ORIGEN.lat],
          [-58.99, -27.455],
          [DESTINO.lng, DESTINO.lat],
        ],
      },
      ...extra,
    },
  ],
});

/** Un fetch falso que anota los pedidos y contesta lo que se le diga. */
function fetchFalso(responder: () => Response | Promise<Response> = () => Response.json(cuerpoOsrm())) {
  const pedidos: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    pedidos.push({ url: String(url), ...(init ? { init } : {}) });
    return responder();
  }) as typeof fetch;
  return { f, pedidos };
}

const osrm = (f: typeof fetch, extra: Partial<ConstructorParameters<typeof MapasOsrm>[0]> = {}) =>
  new MapasOsrm({ url: 'http://osrm.test', timeoutMs: 200, fetch: f, ...extra });

describe('MapasOsrm', () => {
  it('pide la ruta en orden lng,lat y devuelve enteros, los puntos en [lat, lng] y fuente calles', async () => {
    const { f, pedidos } = fetchFalso();
    const ruta = await osrm(f).ruta(ORIGEN, DESTINO);

    expect(pedidos[0]!.url).toBe(
      `http://osrm.test/route/v1/driving/${ORIGEN.lng},${ORIGEN.lat};${DESTINO.lng},${DESTINO.lat}?overview=full&geometries=geojson`,
    );
    expect(ruta).toEqual({
      metros: 4613,
      segundos: 655,
      puntos: [
        [ORIGEN.lat, ORIGEN.lng],
        [-27.455, -58.99],
        [DESTINO.lat, DESTINO.lng],
      ],
      fuente: 'calles',
    });
  });

  it('se identifica ante el servidor sin mandar datos del usuario, y corta con un AbortSignal', async () => {
    const { f, pedidos } = fetchFalso();
    await osrm(f).ruta(ORIGEN, DESTINO);
    const init = pedidos[0]!.init!;
    expect(new Headers(init.headers).get('user-agent')).toMatch(/^app-viajes/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('el recorrido de la estimación es el de la ruta (los mismos metros y segundos)', async () => {
    const { f } = fetchFalso();
    expect(await osrm(f).recorrido(ORIGEN, DESTINO)).toEqual({ metros: 4613, segundos: 655 });
  });

  it('la misma ruta sale del caché: un solo pedido, y lo cuenta', async () => {
    const { f, pedidos } = fetchFalso();
    const resultados: string[] = [];
    const mapas = osrm(f, { alResolver: (r) => resultados.push(r) });
    await mapas.recorrido(ORIGEN, DESTINO);
    await mapas.ruta(ORIGEN, DESTINO);
    expect(pedidos).toHaveLength(1);
    expect(resultados).toEqual(['calles', 'cache']);
  });

  it('la misma ruta pedida a la vez (el mapa y la estimación) sale en un solo pedido a OSRM', async () => {
    let soltar!: () => void;
    const espera = new Promise<void>((r) => (soltar = r));
    const { f, pedidos } = fetchFalso(async () => {
      await espera;
      return Response.json(cuerpoOsrm());
    });
    const resultados: string[] = [];
    const mapas = osrm(f, { alResolver: (r) => resultados.push(r) });

    // Las dos antes de que conteste OSRM: la segunda espera la respuesta de la primera.
    const ruta = mapas.ruta(ORIGEN, DESTINO);
    const recorrido = mapas.recorrido(ORIGEN, DESTINO);
    soltar();
    expect(await recorrido).toEqual({ metros: 4613, segundos: 655 });
    expect((await ruta).fuente).toBe('calles');
    expect(pedidos).toHaveLength(1);
    expect(resultados.sort()).toEqual(['cache', 'calles']);
  });

  it('si el pedido compartido falla, falla para todos y el siguiente vuelve a pedir', async () => {
    let soltar!: () => void;
    const espera = new Promise<void>((r) => (soltar = r));
    let respuestas = 0;
    const { f, pedidos } = fetchFalso(async () => {
      respuestas++;
      if (respuestas === 1) {
        await espera;
        return new Response('caído', { status: 503 });
      }
      return Response.json(cuerpoOsrm());
    });
    const mapas = osrm(f);

    const primera = mapas.ruta(ORIGEN, DESTINO);
    const segunda = mapas.ruta(ORIGEN, DESTINO);
    soltar();
    await expect(primera).rejects.toThrow();
    await expect(segunda).rejects.toThrow();
    expect(pedidos).toHaveLength(1);

    // El pedido fallido no queda «en curso» para siempre: el próximo sale de nuevo y anda.
    expect((await mapas.ruta(ORIGEN, DESTINO)).fuente).toBe('calles');
    expect(pedidos).toHaveLength(2);
  });

  it('el caché tiene tope: descarta la ruta usada hace más tiempo', async () => {
    const { f, pedidos } = fetchFalso();
    const mapas = osrm(f, { maxCache: 2 });
    const otro = { lat: -27.46, lng: -58.98 };
    const tercero = { lat: -27.47, lng: -58.97 };
    await mapas.ruta(ORIGEN, DESTINO);
    await mapas.ruta(ORIGEN, otro);
    await mapas.ruta(ORIGEN, DESTINO); // la vuelve a la cola: la más vieja pasa a ser ORIGEN → otro
    await mapas.ruta(ORIGEN, tercero); // descarta ORIGEN → otro
    expect(pedidos).toHaveLength(3);
    await mapas.ruta(ORIGEN, DESTINO);
    expect(pedidos).toHaveLength(3);
    await mapas.ruta(ORIGEN, otro);
    expect(pedidos).toHaveLength(4);
  });

  it.each([
    ['un error HTTP', () => new Response('caído', { status: 502 })],
    ['sin ruta', () => Response.json({ code: 'NoRoute', routes: [] })],
    ['distancia negativa', () => Response.json(cuerpoOsrm({ distance: -1 }))],
    ['geometría con un solo punto', () => Response.json(cuerpoOsrm({ geometry: { coordinates: [[1, 2]] } }))],
    ['geometría con basura', () => Response.json(cuerpoOsrm({ geometry: { coordinates: [[1, 2], 'x'] } }))],
  ])('lanza con %s, y no guarda nada en el caché', async (_caso, responder) => {
    const { f, pedidos } = fetchFalso(responder);
    const mapas = osrm(f);
    await expect(mapas.ruta(ORIGEN, DESTINO)).rejects.toThrow();
    await expect(mapas.ruta(ORIGEN, DESTINO)).rejects.toThrow();
    expect(pedidos).toHaveLength(2);
  });

  it('si OSRM no contesta, el AbortSignal corta el pedido en el timeout', async () => {
    const colgado = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, rechazar) => init?.signal?.addEventListener('abort', () => rechazar(init.signal?.reason)))) as typeof fetch;
    const inicio = Date.now();
    await expect(osrm(colgado, { timeoutMs: 100 }).ruta(ORIGEN, DESTINO)).rejects.toThrow();
    expect(Date.now() - inicio).toBeLessThan(1000);
  });
});

describe('MapasConRespaldo', () => {
  const simulado = new MapasSimulado({ factorDesvio: 1.3, velocidadKmh: 25 });

  it('con OSRM andando, usa sus calles', async () => {
    const { f } = fetchFalso();
    const mapas = new MapasConRespaldo(osrm(f), simulado, silencioso);
    expect((await mapas.ruta(ORIGEN, DESTINO)).fuente).toBe('calles');
    expect(await mapas.recorrido(ORIGEN, DESTINO)).toEqual({ metros: 4613, segundos: 655 });
  });

  it('si OSRM falla, la ruta es la línea recta y la estimación la del simulado; lo cuenta', async () => {
    const { f } = fetchFalso(() => new Response('caído', { status: 503 }));
    let respaldos = 0;
    const mapas = new MapasConRespaldo(osrm(f), simulado, silencioso, () => respaldos++);

    const ruta = await mapas.ruta(ORIGEN, DESTINO);
    expect(ruta).toEqual({
      ...(await simulado.recorrido(ORIGEN, DESTINO)),
      puntos: [
        [ORIGEN.lat, ORIGEN.lng],
        [DESTINO.lat, DESTINO.lng],
      ],
      fuente: 'recta',
    });
    expect(await mapas.recorrido(ORIGEN, DESTINO)).toEqual(await simulado.recorrido(ORIGEN, DESTINO));
    expect(respaldos).toBe(2);
  });
});
