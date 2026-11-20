import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ErrorHttp, crearLogger } from '@viajes/platform';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BuscadorCandidatosLocation } from '../../src/infra/externos/buscador-location.js';

const TOKEN = 'token-de-servicio-de-prueba-con-32-caracteres-o-mas';
const ORIGEN = { lat: -34.6037, lng: -58.3816 };

type Manejador = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

/** location falso: cada test decide qué responde y se guardan los pedidos que recibió. */
let manejar: Manejador;
const pedidos: { url: URL; token: string | undefined }[] = [];
let servidor: Server;
let urlBase: string;

beforeAll(async () => {
  servidor = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://location.test');
    pedidos.push({ url, token: req.headers['x-token-servicio'] as string | undefined });
    manejar(req, res, url);
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', () => r()));
  urlBase = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
afterAll(async () => {
  servidor.closeAllConnections();
  await new Promise<void>((r) => servidor.close(() => r()));
});
afterEach(() => {
  pedidos.length = 0;
});

function json(res: ServerResponse, estado: number, cuerpo: unknown) {
  res.writeHead(estado, { 'content-type': 'application/json' }).end(JSON.stringify(cuerpo));
}

const candidato = (choferId: string, distanciaMetros: number) => ({
  choferId,
  distanciaMetros,
  actualizadaEn: '2026-11-19T12:00:00.000Z',
});

/** Responde con los primeros `limite` choferes de la lista, como haría location. */
function locationCon(choferes: string[]): Manejador {
  return (_req, res, url) => {
    const limite = Number(url.searchParams.get('limite'));
    json(res, 200, { candidatos: choferes.slice(0, limite).map((id, i) => candidato(id, 100 * (i + 1))) });
  };
}

function buscador(opciones: { timeoutMs?: number; url?: string } = {}) {
  return new BuscadorCandidatosLocation({
    urlBase: opciones.url ?? urlBase,
    tokenServicio: TOKEN,
    timeoutMs: opciones.timeoutMs ?? 500,
    radioMetros: 5000,
    logger: crearLogger('test', 'silent'),
  });
}

async function esperar503(promesa: Promise<unknown>) {
  const err = await promesa.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ErrorHttp);
  expect(err).toMatchObject({ estado: 503, codigo: 'UBICACION_NO_DISPONIBLE' });
  // Sin detalles internos: ni la URL de location ni el motivo llegan al cliente.
  expect((err as Error).message).not.toMatch(/127\.0\.0\.1|timeout|location/i);
}

describe('buscador contra location: el pedido', () => {
  it('manda el token de servicio, el origen, el radio y un lote de al menos 10', async () => {
    manejar = locationCon([]);
    await buscador().buscar(ORIGEN, { excluir: [], limite: 3 });

    expect(pedidos).toHaveLength(1);
    const [p] = pedidos;
    expect(p!.token).toBe(TOKEN);
    expect(p!.url.pathname).toBe('/interno/candidatos');
    expect(Object.fromEntries(p!.url.searchParams)).toEqual({
      lat: String(ORIGEN.lat),
      lng: String(ORIGEN.lng),
      limite: '10',
      radioMetros: '5000',
    });
  });

  it('con excluidos pide limite + excluidos, sin pasarse del tope del contrato (100)', async () => {
    manejar = locationCon([]);
    await buscador().buscar(ORIGEN, { excluir: Array.from({ length: 12 }, randomUUID), limite: 3 });
    await buscador().buscar(ORIGEN, { excluir: Array.from({ length: 150 }, randomUUID), limite: 3 });
    expect(pedidos.map((p) => p.url.searchParams.get('limite'))).toEqual(['15', '100']);
  });
});

describe('buscador contra location: la respuesta', () => {
  it('devuelve los ids en el orden de location (del más cercano al más lejano), cortados en limite', async () => {
    const choferes = Array.from({ length: 6 }, randomUUID);
    manejar = locationCon(choferes);
    expect(await buscador().buscar(ORIGEN, { excluir: [], limite: 3 })).toEqual(choferes.slice(0, 3));
  });

  it('saca a los ya ofrecidos y completa con los que siguen', async () => {
    const choferes = Array.from({ length: 6 }, randomUUID);
    manejar = locationCon(choferes);
    const res = await buscador().buscar(ORIGEN, { excluir: [choferes[0]!, choferes[2]!], limite: 3 });
    expect(res).toEqual([choferes[1], choferes[3], choferes[4]]);
  });

  it('nadie cerca → lista vacía, no un error', async () => {
    manejar = locationCon([]);
    expect(await buscador().buscar(ORIGEN, { excluir: [], limite: 3 })).toEqual([]);
  });
});

describe('buscador contra location: falla cerrado con 503', () => {
  it('location no contesta dentro del timeout', async () => {
    manejar = () => {}; // nunca responde
    const inicio = Date.now();
    await esperar503(buscador({ timeoutMs: 150 }).buscar(ORIGEN, { excluir: [], limite: 3 }));
    expect(Date.now() - inicio).toBeLessThan(1000);
  });

  it('location manda los encabezados y se cuelga en el cuerpo', async () => {
    manejar = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"candidatos":[');
    };
    await esperar503(buscador({ timeoutMs: 150 }).buscar(ORIGEN, { excluir: [], limite: 3 }));
  });

  it('location no está levantado (conexión rechazada)', async () => {
    // Un puerto que se abre y se cierra enseguida: nadie escucha ahí.
    const libre = createServer();
    await new Promise<void>((r) => libre.listen(0, '127.0.0.1', () => r()));
    const { port } = libre.address() as AddressInfo;
    await new Promise<void>((r) => libre.close(() => r()));
    await esperar503(buscador({ url: `http://127.0.0.1:${port}` }).buscar(ORIGEN, { excluir: [], limite: 3 }));
  });

  it.each([500, 503, 401, 400])('location responde %i', async (estado) => {
    manejar = (_req, res) => json(res, estado, { error: { code: 'X', message: 'detalle interno de location' } });
    await esperar503(buscador().buscar(ORIGEN, { excluir: [], limite: 3 }));
  });

  it('la respuesta no es JSON', async () => {
    manejar = (_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html>proxy</html>');
    await esperar503(buscador().buscar(ORIGEN, { excluir: [], limite: 3 }));
  });

  it.each([
    ['sin la lista', {}],
    ['un id que no es uuid', { candidatos: [candidato('no-es-uuid', 10)] }],
    ['un campo de más', { candidatos: [{ ...candidato(randomUUID(), 10), flota: 'x' }] }],
  ])('la respuesta no cumple el contrato: %s', async (_caso, cuerpo) => {
    manejar = (_req, res) => json(res, 200, cuerpo);
    await esperar503(buscador().buscar(ORIGEN, { excluir: [], limite: 3 }));
  });
});
