import { describe, expect, it } from 'vitest';
import { conectarEventos, type DependenciasEventos, type EstadoConexion } from '../src/tiempo-real/eventos';
import { LectorSse } from '../src/tiempo-real/lector-sse';

describe('LectorSse', () => {
  it('arma los mensajes aunque lleguen partidos, con data de varias líneas, y saltea comentarios', () => {
    const l = new LectorSse();
    const pedazos = ['retry: 3000\n\nid: 7\nevent: Offer', 'Created\ndata: {"a":', '1}\n\n: latido\n\n', 'data: uno\ndata: dos\n\n'];
    const mensajes = pedazos.flatMap((p) => l.agregar(p));
    expect(mensajes).toEqual([
      { evento: 'OfferCreated', datos: '{"a":1}', id: '7' },
      { evento: 'message', datos: 'uno\ndos', id: null },
    ]);
    expect(l.retry).toBe(3000);
  });

  it('acepta \\r\\n aunque venga partido entre dos pedazos', () => {
    const l = new LectorSse();
    expect(l.agregar('event: X\r\ndata: 1\r')).toEqual([]);
    expect(l.agregar('\n\r\n')).toEqual([{ evento: 'X', datos: '1', id: null }]);
  });

  it('sin data no entrega nada', () => {
    const l = new LectorSse();
    expect(l.agregar('event: Vacio\n\n')).toEqual([]);
  });
});

/** Un cuerpo SSE que manda `texto` y cierra. */
const cuerpo = (texto: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(texto));
      c.close();
    },
  });

describe('conectarEventos', () => {
  it('con 401 renueva una vez y reconecta con el token nuevo; al cortarse, reconecta y avisa otra vez', async () => {
    let token = 'viejo';
    const pedidos: string[] = [];
    const respuestas = [
      () => new Response(JSON.stringify({ error: { code: 'TOKEN_INVALIDO', message: 'vencido' } }), { status: 401 }),
      () => new Response(cuerpo('retry: 10\n\nevent: OfferCreated\ndata: {"ofertaId":"o1"}\n\n')),
      () => new Response(cuerpo('event: TripAssigned\ndata: {"solicitudId":"s1"}\n\n')),
    ];
    const eventos: [string, unknown][] = [];
    const estados: EstadoConexion[] = [];
    let conexiones = 0;
    let cerrar = () => {};
    const terminado = new Promise<void>((fin) => {
      const deps: DependenciasEventos = {
        fetch: async (_url, init) => {
          pedidos.push(new Headers(init?.headers).get('authorization') ?? '');
          const r = respuestas.shift();
          if (!r) {
            cerrar();
            fin();
            throw new TypeError('sin más respuestas');
          }
          return r();
        },
        token: () => token,
        renovar: async () => (token = 'nuevo'),
        epoca: () => 1,
        esperar: async () => {},
        azar: () => 0.5,
      };
      cerrar = conectarEventos(
        { alEvento: (t, d) => eventos.push([t, d]), alConectar: () => conexiones++, alEstado: (e) => estados.push(e) },
        deps,
      );
    });
    await terminado;

    expect(pedidos.slice(0, 3)).toEqual(['Bearer viejo', 'Bearer nuevo', 'Bearer nuevo']);
    expect(eventos).toEqual([
      ['OfferCreated', { ofertaId: 'o1' }],
      ['TripAssigned', { solicitudId: 's1' }],
    ]);
    expect(conexiones).toBe(2);
    // Después de haber estado conectado, cada intento se muestra como reconexión.
    const primeraConexion = estados.indexOf('conectado');
    expect(primeraConexion).toBeGreaterThan(0);
    expect(estados.slice(primeraConexion + 1)).not.toContain('conectando');
    expect(estados).toContain('reconectando');
  });

  it('con 403 se detiene y sin sesión no conecta', async () => {
    const estados: EstadoConexion[] = [];
    let pedidos = 0;
    await new Promise<void>((fin) => {
      conectarEventos(
        {
          alEvento: () => {},
          alEstado: (e) => {
            estados.push(e);
            if (e === 'detenido') fin();
          },
        },
        {
          fetch: async () => (pedidos++, new Response('{}', { status: 403 })),
          token: () => 't',
          renovar: async () => null,
          epoca: () => 1,
          esperar: async () => {},
          azar: () => 0.5,
        },
      );
    });
    expect(pedidos).toBe(1);
    expect(estados.at(-1)).toBe('detenido');
  });
});
