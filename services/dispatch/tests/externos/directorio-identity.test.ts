import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crearLogger, ErrorHttp } from '@viajes/platform';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DirectorioIdentity } from '../../src/infra/externos/directorio-identity.js';

const TOKEN = 'token-de-servicio-de-identity-con-32-caracteres';

/** identity falso: cada test decide qué responde y se guardan los pedidos que recibió. */
let manejar: (req: IncomingMessage, res: ServerResponse) => void;
const pedidos: { ruta: string; token: string | undefined }[] = [];
let servidor: Server;
let urlBase: string;

beforeAll(async () => {
  servidor = createServer((req, res) => {
    pedidos.push({ ruta: req.url ?? '', token: req.headers['x-token-servicio'] as string | undefined });
    manejar(req, res);
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

const json = (res: ServerResponse, estado: number, cuerpo: unknown) =>
  res.writeHead(estado, { 'content-type': 'application/json' }).end(JSON.stringify(cuerpo));

const directorio = (url = urlBase) =>
  new DirectorioIdentity({ urlBase: url, tokenServicio: TOKEN, timeoutMs: 300, logger: crearLogger('test', 'silent') });

describe('DirectorioIdentity', () => {
  it('pregunta por el id con el token de servicio y devuelve el rol', async () => {
    const id = randomUUID();
    manejar = (_req, res) => json(res, 200, { id, rol: 'chofer' });
    expect(await directorio().rolDe(id)).toBe('chofer');
    expect(pedidos).toEqual([{ ruta: `/interno/usuarios/${id}`, token: TOKEN }]);
  });

  it('404 de identity: la cuenta no existe (null)', async () => {
    manejar = (_req, res) => json(res, 404, { error: { code: 'USUARIO_NO_ENCONTRADO' } });
    expect(await directorio().rolDe(randomUUID())).toBeNull();
  });

  const caidas: Array<[string, (req: IncomingMessage, res: ServerResponse) => void]> = [
    ['un 500', (_req, res) => json(res, 500, {})],
    ['un 401 (token mal configurado)', (_req, res) => json(res, 401, {})],
    ['una respuesta fuera de contrato', (_req, res) => json(res, 200, { id: randomUUID(), rol: 'chofer', email: 'x@y.z' })],
    ['otro usuario en la respuesta', (_req, res) => json(res, 200, { id: randomUUID(), rol: 'chofer' })],
    ['un timeout', () => {}],
  ];
  it.each(caidas)('%s: falla cerrado con 503 IDENTITY_NO_DISPONIBLE', async (_caso, manejador) => {
    manejar = manejador;
    const error = await directorio().rolDe(randomUUID()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorHttp);
    expect(error).toMatchObject({ estado: 503, codigo: 'IDENTITY_NO_DISPONIBLE' });
  });

  it('identity apagado: también 503', async () => {
    const error = await directorio('http://127.0.0.1:1').rolDe(randomUUID()).catch((e: unknown) => e);
    expect(error).toMatchObject({ estado: 503, codigo: 'IDENTITY_NO_DISPONIBLE' });
  });
});
