import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { ErrorServicioInterno } from '@viajes/platform';
import { afterEach, describe, expect, it } from 'vitest';
import { TramosDeViajeDispatch } from '../../src/infra/externos/tramos-dispatch.js';

/** El adaptador HTTP de la retención por viaje, contra un dispatch falso: POST, token, contrato y fallas. */
let servidor: Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (servidor ? servidor.close(() => r()) : r()));
  servidor = null;
});

const TOKEN = 't'.repeat(40);

async function dispatchFalso(responder: (req: IncomingMessage, cuerpo: string) => { estado: number; json: unknown }) {
  servidor = createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c: Buffer) => (cuerpo += c.toString()));
    req.on('end', () => {
      const { estado, json } = responder(req, cuerpo);
      res.writeHead(estado, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => servidor!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(servidor!.address() as AddressInfo).port}`;
}

describe('TramosDeViajeDispatch', () => {
  it('manda un POST con el token y el cuerpo, y convierte las fechas', async () => {
    const chofer = randomUUID();
    let visto: { metodo?: string; ruta?: string; token?: string; tipo?: string; cuerpo?: unknown } = {};
    const url = await dispatchFalso((req, cuerpo) => {
      visto = { metodo: req.method, ruta: req.url, token: req.headers['x-token-servicio'] as string, tipo: req.headers['content-type'], cuerpo: JSON.parse(cuerpo) };
      return {
        estado: 200,
        json: { tramos: [{ choferId: chofer, inicio: '2026-11-20T10:00:00.000Z', fin: null }] },
      };
    });
    const desde = new Date('2026-11-20T09:00:00.000Z');
    const hasta = new Date('2026-11-20T11:00:00.000Z');
    const tramos = await new TramosDeViajeDispatch({ urlBase: url, tokenServicio: TOKEN, timeoutMs: 1000 }).tramos([chofer], desde, hasta);

    expect(visto).toEqual({
      metodo: 'POST',
      ruta: '/interno/tramos-viaje',
      token: TOKEN,
      tipo: 'application/json',
      cuerpo: { choferes: [chofer], desde: desde.toISOString(), hasta: hasta.toISOString() },
    });
    expect(tramos).toEqual([{ choferId: chofer, inicio: new Date('2026-11-20T10:00:00.000Z'), fin: null }]);
  });

  it.each([
    ['un 401', { estado: 401, json: { error: { code: 'TOKEN_SERVICIO_INVALIDO' } } }],
    ['una respuesta fuera del contrato', { estado: 200, json: { tramos: [{ choferId: 'x' }] } }],
  ])('con %s lanza ErrorServicioInterno (la retención conserva el lote)', async (_caso, respuesta) => {
    const url = await dispatchFalso(() => respuesta);
    const adaptador = new TramosDeViajeDispatch({ urlBase: url, tokenServicio: TOKEN, timeoutMs: 1000 });
    await expect(adaptador.tramos([randomUUID()], new Date(0), new Date(1))).rejects.toBeInstanceOf(ErrorServicioInterno);
  });
});
