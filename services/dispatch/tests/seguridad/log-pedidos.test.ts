import { crearApp, crearLogger, type ChequeoListo } from '@viajes/platform';
import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

type Linea = Record<string, unknown>;

/** Una app con un logger que escribe en memoria, para leer las líneas que deja cada pedido. */
function appConLog(opciones: { logPedidos?: boolean; chequeos?: ChequeoListo[] } = {}) {
  const lineas: Linea[] = [];
  const logger = crearLogger('log-test', 'info', { write: (texto: string) => void lineas.push(JSON.parse(texto) as Linea) });
  const r = Router();
  r.get('/viajes/:id', (_req, res) => {
    res.json({ ok: true });
  });
  r.get('/roto', () => {
    throw new Error('detalle interno que no tiene que salir');
  });
  const app = crearApp({ logger, rutas: r, chequeos: opciones.chequeos ?? [], logPedidos: opciones.logPedidos ?? true });
  return { app, lineas };
}

const pedidos = (lineas: Linea[]) => lineas.filter((l) => l['msg'] === 'pedido');

/** La línea se escribe en `finish`, que puede llegar después de que supertest resuelve. */
const esperarLineas = () => new Promise((r) => setTimeout(r, 20));

describe('log por pedido (bloque 4)', () => {
  it('una línea con método, ruta como patrón, estado, duración y requestId', async () => {
    const { app, lineas } = appConLog();
    const res = await request(app).get('/viajes/123e4567-e89b-42d3-a456-426614174000?q=secreto');
    await esperarLineas();
    const [linea] = pedidos(lineas);
    expect(linea).toMatchObject({
      level: 30,
      metodo: 'GET',
      ruta: '/viajes/:id',
      estado: 200,
      requestId: res.headers['x-request-id'],
    });
    expect(typeof linea?.['duracionMs']).toBe('number');
    // Ni el id ni la query quedan en el log.
    expect(JSON.stringify(linea)).not.toContain('123e4567');
    expect(JSON.stringify(linea)).not.toContain('secreto');
  });

  it('un error 500: la respuesta no tiene detalles y el log se relaciona por requestId', async () => {
    const { app, lineas } = appConLog();
    const res = await request(app).get('/roto').set('x-request-id', 'pedido-de-prueba-1');
    await esperarLineas();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNO', message: 'Error interno', requestId: 'pedido-de-prueba-1' } });
    expect(JSON.stringify(res.body)).not.toContain('detalle interno');

    const error = lineas.find((l) => l['msg'] === 'error no controlado');
    const pedido = pedidos(lineas)[0];
    expect(error?.['requestId']).toBe('pedido-de-prueba-1');
    expect(pedido).toMatchObject({ requestId: 'pedido-de-prueba-1', estado: 500, level: 50, ruta: '/roto' });
  });

  it('4xx en warn; una ruta que no existe queda como sin_ruta', async () => {
    const { app, lineas } = appConLog();
    await request(app).get('/no-existe/abc');
    await esperarLineas();
    expect(pedidos(lineas)[0]).toMatchObject({ level: 40, estado: 404, ruta: 'sin_ruta' });
  });

  it('las sondas (/health) no se loguean si responden bien', async () => {
    const { app, lineas } = appConLog();
    await request(app).get('/health');
    await esperarLineas();
    expect(pedidos(lineas)).toEqual([]);
  });

  it('/ready caído sí se loguea', async () => {
    const { app, lineas } = appConLog({ chequeos: [{ nombre: 'db', chequear: () => Promise.reject(new Error('caída')) }] });
    const res = await request(app).get('/ready');
    await esperarLineas();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(pedidos(lineas)[0]).toMatchObject({ ruta: '/ready', estado: res.status });
  });

  it('LOG_PEDIDOS=no: ninguna línea por pedido', async () => {
    const { app, lineas } = appConLog({ logPedidos: false });
    await request(app).get('/viajes/1');
    await esperarLineas();
    expect(pedidos(lineas)).toEqual([]);
  });
});
