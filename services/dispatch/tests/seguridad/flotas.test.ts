import { randomUUID } from 'node:crypto';
import type { Rol } from '@viajes/platform';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { preparadorFlotas, vehiculo } from '../soporte/flotas.js';
import { clave, levantarDispatch } from '../soporte/sistema-postgres.js';

/** Permisos y validación de las rutas de flotas: quién puede qué, y qué cuerpos se rechazan. */
let d: Awaited<ReturnType<typeof levantarDispatch>>;
let flotaId: string;
let choferId: string;

beforeAll(async () => {
  d = await levantarDispatch();
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiarFlotas();
  const preparar = preparadorFlotas(d.casosFlotas, d.directorio);
  flotaId = (await preparar.flota(3)).id;
  [choferId] = (await preparar.choferes(flotaId, 1)) as [string];
});

const PERIODO = 'inicio=2026-11-01T00:00:00-03:00&fin=2026-12-01T00:00:00-03:00';

type Ruta = { metodo: 'get' | 'post' | 'put'; ruta: () => string; cuerpo?: () => object; roles: Rol[] };

const RUTAS: Ruta[] = [
  { metodo: 'put', ruta: () => `/admin/flotas/${flotaId}`, cuerpo: () => ({ nombre: 'X', maxActivos: 3 }), roles: ['admin'] },
  { metodo: 'post', ruta: () => `/admin/choferes/${choferId}/habilitar`, cuerpo: () => ({}), roles: ['admin'] },
  { metodo: 'post', ruta: () => `/admin/choferes/${choferId}/deshabilitar`, cuerpo: () => ({}), roles: ['admin'] },
  { metodo: 'get', ruta: () => '/flota', roles: ['admin_flota'] },
  { metodo: 'get', ruta: () => '/flota/choferes', roles: ['admin_flota'] },
  { metodo: 'get', ruta: () => `/flota/reporte?${PERIODO}`, roles: ['admin_flota'] },
  { metodo: 'get', ruta: () => `/flota/choferes/${choferId}`, roles: ['admin_flota'] },
  {
    metodo: 'post',
    ruta: () => '/flota/choferes',
    cuerpo: () => ({ choferId: randomUUID(), vehiculo: vehiculo() }),
    roles: ['admin_flota'],
  },
  { metodo: 'post', ruta: () => `/flota/choferes/${choferId}/activar`, cuerpo: () => ({}), roles: ['admin_flota'] },
  { metodo: 'post', ruta: () => `/flota/choferes/${choferId}/desactivar`, cuerpo: () => ({}), roles: ['admin_flota'] },
  { metodo: 'put', ruta: () => '/chofer/disponibilidad', cuerpo: () => ({ disponible: false }), roles: ['chofer'] },
];
const TODOS: Rol[] = ['pasajero', 'chofer', 'operador', 'admin', 'admin_flota'];

const pedir = (r: Ruta) => {
  const p = request(d.url)[r.metodo](r.ruta()).set(clave());
  return r.cuerpo ? p.send(r.cuerpo()) : p;
};

describe('permisos', () => {
  it.each(RUTAS.map((r) => [`${r.metodo.toUpperCase()} ${r.ruta.toString().match(/`(.*)`|'(.*)'/)?.slice(1).find(Boolean)}`, r]))(
    '%s: sin token 401 y con otro rol 403',
    async (_nombre, r) => {
      expect((await pedir(r)).status).toBe(401);
      for (const rol of TODOS.filter((x) => !r.roles.includes(x))) {
        const res = await pedir(r).set(rol === 'admin_flota' ? await d.authFlota(randomUUID(), flotaId) : await d.auth(randomUUID(), rol));
        expect(res.status, rol).toBe(403);
        expect(res.body.error.code).toBe('ROL_NO_PERMITIDO');
      }
    },
  );

  it('un admin_flota sin fleetId en el token recibe 403 en todas sus rutas', async () => {
    for (const r of RUTAS.filter((x) => x.roles.includes('admin_flota'))) {
      const res = await pedir(r).set(await d.auth(randomUUID(), 'admin_flota'));
      expect(res.status, r.ruta()).toBe(403);
      expect(res.body.error.code).toBe('FLOTA_NO_ASIGNADA');
    }
  });

  it('un admin_flota con una flota que dispatch no conoce recibe 404', async () => {
    const res = await request(d.url).get('/flota').set(await d.authFlota(randomUUID(), randomUUID()));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FLOTA_NO_ENCONTRADA');
  });
});

describe('validación', () => {
  const alta = async (cuerpo: unknown) =>
    request(d.url).post('/flota/choferes').set(clave()).set(await d.authFlota(randomUUID(), flotaId)).send(cuerpo as object);

  it.each([
    ['la flota en el body', { choferId: randomUUID(), vehiculo: vehiculo(), fleetId: randomUUID() }],
    ['__proto__', JSON.parse(`{"choferId":"${randomUUID()}","vehiculo":{"patente":"AB123CD","marca":"a","modelo":"b"},"__proto__":{"x":1}}`)],
    ['una clave extra en el vehículo', { choferId: randomUUID(), vehiculo: { ...vehiculo(), color: 'rojo' } }],
    ['una patente mal formada', { choferId: randomUUID(), vehiculo: { ...vehiculo(), patente: 'A1' } }],
    ['un choferId que no es UUID', { choferId: 'no-uuid', vehiculo: vehiculo() }],
  ])('el alta rechaza %s con 400', async (_caso, cuerpo) => {
    const res = await alta(cuerpo);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDACION');
  });

  it.each([
    ['negativo', { nombre: 'X', maxActivos: -1 }],
    ['fraccionario', { nombre: 'X', maxActivos: 1.5 }],
    ['de texto', { nombre: 'X', maxActivos: '3' }],
    ['sin nombre', { nombre: '  ', maxActivos: 3 }],
    ['con el contador', { nombre: 'X', maxActivos: 3, activos: 0 }],
  ])('PUT /admin/flotas/:id rechaza un límite %s con 400', async (_caso, cuerpo) => {
    const res = await request(d.url).put(`/admin/flotas/${flotaId}`).set(clave()).set(await d.auth(randomUUID(), 'admin')).send(cuerpo);
    expect(res.status).toBe(400);
    expect(await d.prisma.flota.findUniqueOrThrow({ where: { id: flotaId } })).toMatchObject({ maxActivos: 3 });
  });

  it('la disponibilidad solo acepta un booleano y nada más', async () => {
    const auth = await d.auth(choferId, 'chofer');
    for (const cuerpo of [{ disponible: 'si' }, { disponible: true, choferId: randomUUID() }, {}]) {
      expect((await request(d.url).put('/chofer/disponibilidad').set(clave()).set(auth).send(cuerpo)).status).toBe(400);
    }
  });

  it.each([
    ['sin fin', 'inicio=2026-11-01T00:00:00Z'],
    ['sin inicio', 'fin=2026-11-01T00:00:00Z'],
    ['inicio igual a fin', 'inicio=2026-11-01T00:00:00Z&fin=2026-11-01T00:00:00Z'],
    ['inicio después de fin', 'inicio=2026-11-02T00:00:00Z&fin=2026-11-01T00:00:00Z'],
    ['más de 366 días', 'inicio=2025-01-01T00:00:00Z&fin=2026-01-02T00:00:01Z'],
    ['una fecha sin zona horaria', 'inicio=2026-11-01T00:00:00&fin=2026-12-01T00:00:00Z'],
    ['una fecha sola', 'inicio=2026-11-01&fin=2026-12-01'],
    ['la flota en la query', `${PERIODO}&fleetId=${randomUUID()}`],
    ['una clave extra', `${PERIODO}&estado=COMPLETADA`],
  ])('GET /flota/reporte rechaza %s con 400', async (_caso, query) => {
    const res = await request(d.url).get(`/flota/reporte?${query}`).set(await d.authFlota(randomUUID(), flotaId));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDACION');
  });

  it('GET /flota/reporte acepta 366 días justos', async () => {
    const res = await request(d.url)
      .get('/flota/reporte?inicio=2024-01-01T00:00:00Z&fin=2025-01-01T00:00:00Z')
      .set(await d.authFlota(randomUUID(), flotaId));
    expect(res.status).toBe(200);
  });

  it('las escrituras de /flota exigen Idempotency-Key', async () => {
    const res = await request(d.url)
      .post(`/flota/choferes/${choferId}/activar`)
      .set(await d.authFlota(randomUUID(), flotaId))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CLAVE_IDEMPOTENCIA_INVALIDA');
  });
});
