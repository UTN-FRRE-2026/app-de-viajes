import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RutaRespuesta } from '@viajes/contracts';
import { crearLogger, type Rol } from '@viajes/platform';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { componer, type Sistema } from '../../src/composicion.js';
import { CON_METRICAS, configTest } from '../soporte/sistema-postgres.js';
import { crearEmisorTokens } from '../soporte/tokens.js';

// Un OSRM falso en un puerto local: el mismo camino que en producción (fetch real, timeout, respaldo),
// sin salir a internet. `caido` lo hace responder 500.
let caido = false;
let pedidosOsrm = 0;
const osrmFalso: Server = createServer((req, res) => {
  pedidosOsrm++;
  if (caido) {
    res.writeHead(500).end();
    return;
  }
  const [o, d] = (req.url ?? '').split('/driving/')[1]!.split('?')[0]!.split(';');
  const [oLng, oLat] = o!.split(',').map(Number);
  const [dLng, dLat] = d!.split(',').map(Number);
  res.writeHead(200, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      code: 'Ok',
      routes: [{ distance: 3210.4, duration: 480.6, geometry: { coordinates: [[oLng, oLat], [oLng, dLat], [dLng, dLat]] } }],
    }),
  );
});

let conOsrm: Sistema;
let simulado: Sistema;
let auth: Awaited<ReturnType<typeof crearEmisorTokens>>['auth'];

beforeAll(async () => {
  await new Promise<void>((listo) => osrmFalso.listen(0, '127.0.0.1', listo));
  const url = `http://127.0.0.1:${(osrmFalso.address() as AddressInfo).port}`;
  const tokens = await crearEmisorTokens();
  auth = tokens.auth;
  const logger = crearLogger('dispatch-test', 'silent');
  conOsrm = componer(
    configTest({ DISPATCH_PERSISTENCIA: 'memoria', MAPAS_PROVEEDOR: 'osrm', MAPAS_OSRM_URL: url, LIMITE_RUTAS_POR_MINUTO: '5' }),
    logger,
    { verificador: tokens.verificador },
  );
  simulado = componer(configTest({ DISPATCH_PERSISTENCIA: 'memoria' }), logger, { verificador: tokens.verificador });
});
afterAll(async () => {
  await conOsrm.cerrar();
  await simulado.cerrar();
  await new Promise((listo) => osrmFalso.close(listo));
});

const query = (destinoLat = '-27.4700') => ({ origenLat: '-27.4511', origenLng: '-58.9865', destinoLat, destinoLng: '-58.9700' });
const pedir = async (s: Sistema, rol: Rol = 'pasajero', q: Record<string, string> = query(), usuario = randomUUID()) =>
  request(s.app).get('/rutas').query(q).set(await auth(usuario, rol));

describe('GET /rutas', () => {
  it('sin token → 401', async () => {
    expect((await request(conOsrm.app).get('/rutas').query(query())).status).toBe(401);
  });

  it.each(['pasajero', 'chofer', 'operador', 'admin'] as const)('%s puede pedirla', async (rol) => {
    expect((await pedir(conOsrm, rol)).status).toBe(200);
  });

  it('coordenadas fuera de rango → 400', async () => {
    expect((await pedir(conOsrm, 'pasajero', { ...query(), origenLat: '123' })).status).toBe(400);
  });

  it('con OSRM: la ruta por las calles, en [lat, lng], privada y cacheable un rato', async () => {
    caido = false;
    const res = await pedir(conOsrm, 'pasajero', query('-27.4800'));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(RutaRespuesta.parse(res.body)).toEqual({
      distanciaMetros: 3210,
      duracionSegundos: 481,
      puntos: [
        [-27.4511, -58.9865],
        [-27.48, -58.9865],
        [-27.48, -58.97],
      ],
      fuente: 'calles',
    });
  });

  it('la estimación usa la misma ruta: mismos metros, y sale del caché (OSRM no se pide de nuevo)', async () => {
    caido = false;
    await pedir(conOsrm, 'pasajero', query('-27.4900'));
    const antes = pedidosOsrm;
    const res = await request(conOsrm.app).get('/tarifas/estimacion').query(query('-27.4900')).set(await auth(randomUUID(), 'pasajero'));
    expect(res.status).toBe(200);
    expect(res.body.distanciaMetros).toBe(3210);
    expect(pedidosOsrm).toBe(antes);
  });

  it('si OSRM se cae, la línea recta (200, fuente recta), y la estimación sigue andando', async () => {
    caido = true;
    try {
      const res = await pedir(conOsrm, 'pasajero', query('-27.5000'));
      expect(res.status).toBe(200);
      expect(RutaRespuesta.parse(res.body)).toMatchObject({
        fuente: 'recta',
        puntos: [
          [-27.4511, -58.9865],
          [-27.5, -58.97],
        ],
      });
      const est = await request(conOsrm.app).get('/tarifas/estimacion').query(query('-27.5100')).set(await auth(randomUUID(), 'pasajero'));
      expect(est.status).toBe(200);
    } finally {
      caido = false;
    }
  });

  it('cuenta las rutas en /metrics: calles, cache y respaldo', async () => {
    const res = await request(conOsrm.app).get('/metrics').set(CON_METRICAS);
    for (const r of ['calles', 'cache', 'respaldo']) expect(res.text).toMatch(new RegExp(`dispatch_ruteo_total\\{[^}]*resultado="${r}"[^}]*\\} [1-9]`));
  });

  it('tiene límite por usuario: pasado el máximo, 429', async () => {
    const usuario = randomUUID();
    const codigos: number[] = [];
    for (let i = 0; i < 6; i++) codigos.push((await pedir(conOsrm, 'pasajero', query(), usuario)).status);
    expect(codigos.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codigos[5]).toBe(429);
  });

  it('con el simulado (por defecto): la línea recta', async () => {
    const res = await pedir(simulado);
    expect(res.status).toBe(200);
    expect(RutaRespuesta.parse(res.body).fuente).toBe('recta');
  });
});
