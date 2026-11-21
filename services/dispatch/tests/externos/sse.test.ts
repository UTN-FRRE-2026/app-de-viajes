import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { crearLogger, middlewareErrores, type Usuario } from '@viajes/platform';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { BusEventosMemoria } from '../../src/infra/tiempo-real/bus-memoria.js';
import { StreamsEventos, type OpcionesStreams } from '../../src/infra/tiempo-real/sse.js';
import type { BusEventos, EventoEntregable } from '../../src/infra/tiempo-real/tipos.js';
import { abrirStream, type StreamDePrueba } from '../soporte/sse.js';

/** El stream SSE solo, con un bus en memoria: para los casos de tiempo que contra Redis no se pueden forzar. */
const USUARIO = '00000000-0000-4000-8000-0000000000aa';
const logger = crearLogger('sse-test', 'silent');
const servidores: Server[] = [];
const streams: StreamDePrueba[] = [];

afterEach(() => {
  for (const s of streams.splice(0)) s.cerrar();
  for (const s of servidores.splice(0)) s.close();
});

async function levantar(opciones: Partial<OpcionesStreams> & { bus: BusEventos }) {
  const sse = new StreamsEventos({ historial: { desde: async () => [] }, logger, ...opciones });
  const app = express();
  app.use((req, _res, next) => {
    req.usuario = { id: USUARIO, rol: 'pasajero' } satisfies Usuario;
    next();
  });
  app.get('/eventos', sse.manejador());
  app.use(middlewareErrores(logger));
  const servidor = await new Promise<Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  servidores.push(servidor);
  const abrir = async (encabezados: Record<string, string> = {}) => {
    const s = await abrirStream(`http://127.0.0.1:${(servidor.address() as AddressInfo).port}/eventos`, encabezados);
    streams.push(s);
    return s;
  };
  return { sse, abrir };
}

const evento = (seq: number): EventoEntregable => ({
  seq,
  tipo: 'DriverEnRoute',
  payload: { orden: seq },
  destinatarios: [USUARIO],
});
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('stream SSE', () => {
  it('lo que llega mientras se repone no se pierde ni se repite, y sale después de lo repuesto', async () => {
    const bus = new BusEventosMemoria();
    const durante: { publicar?: () => Promise<void> } = {};
    const { abrir } = await levantar({
      bus,
      historial: {
        // La reposición tarda; mientras tanto se publican el 5 (que también se repone) y el 6.
        desde: async (_u, desde) => {
          expect(desde).toBe(3);
          await durante.publicar?.();
          await dormir(50);
          return [evento(4), evento(5)];
        },
      },
    });
    durante.publicar = async () => {
      await bus.publicar(evento(6));
      await bus.publicar(evento(5));
    };
    const s = await abrir({ 'Last-Event-ID': '3' });
    await s.esperar((e) => e.id === '6');
    await dormir(50);
    expect(s.eventos.map((e) => e.id)).toEqual(['4', '5', '6']);
  });

  it('en vivo, descarta lo que no supera el Last-Event-ID y lo repetido', async () => {
    const bus = new BusEventosMemoria();
    const { abrir } = await levantar({ bus });
    const s = await abrir({ 'Last-Event-ID': '10' });
    for (const seq of [9, 10, 11, 11, 12]) await bus.publicar(evento(seq));
    await s.esperar((e) => e.id === '12');
    expect(s.eventos.map((e) => e.id)).toEqual(['11', '12']);
  });

  it('manda latidos para que un proxy no corte la conexión por inactividad', async () => {
    const { abrir } = await levantar({ bus: new BusEventosMemoria(), latidoMs: 30 });
    const s = await abrir();
    await dormir(120);
    expect(s.comentarios.filter((c) => c === 'latido').length).toBeGreaterThanOrEqual(2);
  });

  it('si no se puede suscribir (Redis caído): 503 y no queda ocupado el cupo', async () => {
    const roto: BusEventos = {
      publicar: async () => {},
      suscribir: () => Promise.reject(new Error('ECONNREFUSED')),
      cerrar: async () => {},
    };
    const { sse, abrir } = await levantar({ bus: roto, maxPorUsuario: 1 });
    const s = await abrir();
    expect(s.estado).toBe(503);
    expect(JSON.parse(s.cuerpo()).error.code).toBe('EVENTOS_NO_DISPONIBLE');
    expect(sse.cantidad).toBe(0);
  });

  it('al cerrarse el cliente, se da de baja del bus', async () => {
    const bus = new BusEventosMemoria();
    let bajas = 0;
    const contando: BusEventos = {
      publicar: (e) => bus.publicar(e),
      suscribir: async (u, f) => {
        const baja = await bus.suscribir(u, f);
        return async () => {
          bajas++;
          await baja();
        };
      },
      cerrar: () => bus.cerrar(),
    };
    const { sse, abrir } = await levantar({ bus: contando });
    const s = await abrir();
    expect(sse.cantidad).toBe(1);
    s.cerrar();
    await dormir(50);
    expect(sse.cantidad).toBe(0);
    expect(bajas).toBe(1);
  });
});
