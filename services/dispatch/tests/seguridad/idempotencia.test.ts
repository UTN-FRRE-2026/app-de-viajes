import { randomUUID } from 'node:crypto';
import type { Rol } from '@viajes/platform';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clave, DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';

/** Idempotency-Key (PLAN 3.5) contra Postgres y Redis reales. */
let d: Awaited<ReturnType<typeof levantarDispatch>>;

beforeAll(async () => {
  d = await levantarDispatch();
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
  // Con algún chofer cerca, la solicitud queda BUSCANDO: activa y cancelable (sin choferes sería SIN_CHOFERES).
  d.buscador.choferes = [randomUUID()];
});

const cuerpo = { origen: ORIGEN, destino: DESTINO };
const conClave = (valor: string) => ({ 'Idempotency-Key': valor });

const eventos = (tipo: string) => d.prisma.eventoOutbox.count({ where: { tipo } });

async function pedir(pasajero: string, encabezados: Record<string, string> = clave()) {
  return request(d.url).post('/solicitudes').set(encabezados).set(await d.auth(pasajero, 'pasajero')).send(cuerpo);
}

/** Las seis rutas con efecto, con un usuario que tiene permiso para llamarlas. */
const RUTAS: { ruta: string; rol: Rol; body: object }[] = [
  { ruta: '/solicitudes', rol: 'pasajero', body: cuerpo },
  { ruta: `/solicitudes/${randomUUID()}/cancelar`, rol: 'pasajero', body: {} },
  { ruta: `/solicitudes/${randomUUID()}/en-camino`, rol: 'chofer', body: {} },
  { ruta: `/solicitudes/${randomUUID()}/iniciar`, rol: 'chofer', body: {} },
  { ruta: `/solicitudes/${randomUUID()}/finalizar`, rol: 'chofer', body: {} },
  { ruta: `/ofertas/${randomUUID()}/aceptar`, rol: 'chofer', body: {} },
];

describe('validación del encabezado', () => {
  it.each(RUTAS)('$ruta sin Idempotency-Key → 400', async ({ ruta, rol, body }) => {
    const res = await request(d.url).post(ruta).set(await d.auth(randomUUID(), rol)).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CLAVE_IDEMPOTENCIA_INVALIDA');
    expect(res.body.error.message).toContain('falta');
  });

  it.each([
    ['muy corta', 'abc123'],
    ['muy larga', 'a'.repeat(129)],
    ['con espacios', 'clave con espacios 123'],
    ['dos claves separadas por coma', `${randomUUID()}, ${randomUUID()}`],
    ['con dos puntos (se mezclaría con la clave de Redis)', `otro:usuario:${randomUUID()}`],
    ['con comillas y punto y coma', `'; DROP TABLE idempotency_keys; --`],
  ])('clave %s → 400 y no se crea nada', async (_caso, valor) => {
    const res = await pedir(randomUUID(), conClave(valor));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CLAVE_IDEMPOTENCIA_INVALIDA');
    expect(await d.prisma.solicitudViaje.count()).toBe(0);
  });

  it('un pedido rechazado por permisos no ocupa la clave', async () => {
    const valor = randomUUID();
    const chofer = randomUUID();
    const prohibido = await request(d.url).post('/solicitudes').set(conClave(valor)).set(await d.auth(chofer, 'chofer')).send(cuerpo);
    expect(prohibido.status).toBe(403);
    expect(await d.prisma.registroIdempotencia.count()).toBe(0);
  });
});

describe('la misma petición dos veces: un solo efecto y la misma respuesta', () => {
  it('crear la solicitud: el reintento recibe el mismo 201, marcado como repetido', async () => {
    const pasajero = randomUUID();
    const encabezados = clave();
    const primera = await pedir(pasajero, encabezados);
    const reintento = await pedir(pasajero, encabezados);

    expect(primera.status).toBe(201);
    expect(primera.headers['idempotent-replayed']).toBeUndefined();
    expect(reintento.status).toBe(201);
    expect(reintento.headers['idempotent-replayed']).toBe('true');
    // Byte a byte: la respuesta se guarda como json (no jsonb), con las claves en el mismo orden.
    expect(reintento.text).toBe(primera.text);

    expect(await d.prisma.solicitudViaje.count()).toBe(1);
    expect(await eventos('RideRequested')).toBe(1);
    expect(await d.prisma.registroIdempotencia.count()).toBe(1);

    // Contraste: con otra clave es otra operación, y el dominio la rechaza.
    const otraClave = await pedir(pasajero);
    expect(otraClave.status).toBe(409);
    expect(otraClave.body.error.code).toBe('SOLICITUD_ACTIVA_EXISTENTE');
  });

  it('aceptar, en camino, iniciar, finalizar y cancelar: cada reintento repite la respuesta sin repetir el evento', async () => {
    const pasajero = randomUUID();
    const chofer = randomUUID();
    d.buscador.choferes = [chofer];
    const creada = await pedir(pasajero);
    const oferta = await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId: creada.body.id } });
    const comoChofer = await d.auth(chofer, 'chofer');

    const dosVeces = async (ruta: string, auth: Record<string, string>, body: object = {}) => {
      const encabezados = clave();
      const a = await request(d.url).post(ruta).set(encabezados).set(auth).send(body);
      const b = await request(d.url).post(ruta).set(encabezados).set(auth).send(body);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(b.text).toBe(a.text);
      return a.body;
    };

    const id = creada.body.id as string;
    expect((await dosVeces(`/ofertas/${oferta.id}/aceptar`, comoChofer)).estado).toBe('ASIGNADO');
    expect((await dosVeces(`/solicitudes/${id}/en-camino`, comoChofer)).estado).toBe('EN_CAMINO');
    expect((await dosVeces(`/solicitudes/${id}/iniciar`, comoChofer)).estado).toBe('EN_CURSO');
    expect((await dosVeces(`/solicitudes/${id}/finalizar`, comoChofer)).estado).toBe('COMPLETADA');
    for (const tipo of ['TripAssigned', 'DriverEnRoute', 'TripStarted', 'RideCompleted']) {
      expect(await eventos(tipo)).toBe(1);
    }

    // Cancelar, con otro viaje.
    const pasajero2 = randomUUID();
    const segunda = await pedir(pasajero2);
    const cancelada = await dosVeces(`/solicitudes/${segunda.body.id}/cancelar`, await d.auth(pasajero2, 'pasajero'), {
      motivo: 'me equivoqué de destino',
    });
    expect(cancelada.estado).toBe('CANCELADO_PASAJERO');
    expect(await eventos('RideCancelled')).toBe(1);
  });
});

describe('la misma clave con otro pedido → 422', () => {
  it('otro cuerpo: 422 y no se procesa', async () => {
    const pasajero = randomUUID();
    const encabezados = clave();
    expect((await pedir(pasajero, encabezados)).status).toBe(201);

    const otroDestino = await request(d.url)
      .post('/solicitudes')
      .set(encabezados)
      .set(await d.auth(pasajero, 'pasajero'))
      .send({ origen: ORIGEN, destino: { lat: -34.62, lng: -58.44 } });
    expect(otroDestino.status).toBe(422);
    expect(otroDestino.body.error.code).toBe('CLAVE_IDEMPOTENCIA_REUTILIZADA');
    expect(await d.prisma.solicitudViaje.count()).toBe(1);
  });

  it('otra ruta: 422, aunque el cuerpo sea igual', async () => {
    const pasajero = randomUUID();
    const auth = await d.auth(pasajero, 'pasajero');
    const encabezados = clave();
    const creada = await request(d.url).post(`/solicitudes`).set(encabezados).set(auth).send(cuerpo);
    const cancelar = await request(d.url).post(`/solicitudes/${creada.body.id}/cancelar`).set(encabezados).set(auth).send({});
    expect(cancelar.status).toBe(422);
    expect((await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: creada.body.id } })).estado).toBe('BUSCANDO');
  });

  it('el mismo cuerpo con las claves en otro orden es la misma petición', async () => {
    const pasajero = randomUUID();
    const encabezados = clave();
    expect((await pedir(pasajero, encabezados)).status).toBe(201);
    const desordenado = await request(d.url)
      .post('/solicitudes')
      .set(encabezados)
      .set(await d.auth(pasajero, 'pasajero'))
      .set('content-type', 'application/json')
      .send(`{"destino":{"lng":${DESTINO.lng},"lat":${DESTINO.lat}},"origen":{"lng":${ORIGEN.lng},"lat":${ORIGEN.lat}}}`);
    expect(desordenado.status).toBe(201);
    expect(desordenado.headers['idempotent-replayed']).toBe('true');
  });
});

describe('alcance y errores', () => {
  it('la clave es de cada usuario: el mismo valor en otro pasajero es otra operación', async () => {
    const encabezados = clave();
    const ana = await pedir(randomUUID(), encabezados);
    const beto = await pedir(randomUUID(), encabezados);
    expect(ana.status).toBe(201);
    expect(beto.status).toBe(201);
    expect(beto.headers['idempotent-replayed']).toBeUndefined();
    expect(beto.body.id).not.toBe(ana.body.id);
    expect(await d.prisma.solicitudViaje.count()).toBe(2);
  });

  it('un error no se guarda: sin efecto, el reintento con la misma clave se vuelve a procesar', async () => {
    const pasajero = randomUUID();
    const auth = await d.auth(pasajero, 'pasajero');
    const activa = await pedir(pasajero);

    const encabezados = clave();
    const rechazada = await pedir(pasajero, encabezados);
    expect(rechazada.status).toBe(409);
    expect(await d.prisma.registroIdempotencia.count()).toBe(1); // solo el de la primera

    await request(d.url).post(`/solicitudes/${activa.body.id}/cancelar`).set(clave()).set(auth).send({}).expect(200);
    const reintento = await pedir(pasajero, encabezados);
    expect(reintento.status).toBe(201);
    expect(reintento.headers['idempotent-replayed']).toBeUndefined();
  });
});

describe('cuando falla una de las dos capas', () => {
  it('Redis no responde: 503 y no se procesa (falla cerrado)', async () => {
    const caido = await levantarDispatch({
      idempotencia: ({ almacen }) => ({
        almacen,
        cerrojo: {
          tomar: () => Promise.reject(new Error('ECONNREFUSED')),
          soltar: () => Promise.resolve(),
        },
      }),
    });
    try {
      const res = await request(caido.url).post('/solicitudes').set(clave()).set(await caido.auth(randomUUID(), 'pasajero')).send(cuerpo);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('IDEMPOTENCIA_NO_DISPONIBLE');
      expect(await d.prisma.solicitudViaje.count()).toBe(0);
    } finally {
      await caido.cerrar();
    }
  });

  it('el cerrojo venció con el pedido en curso: la clave primaria del registro impide el segundo efecto', async () => {
    // El peor caso: el cerrojo ya no protege y la búsqueda previa no ve el registro (llegó justo antes del COMMIT).
    const sinRedis = await levantarDispatch({
      idempotencia: ({ almacen }) => ({
        almacen: { buscar: () => Promise.resolve(null), guardar: (r) => almacen.guardar(r) },
        cerrojo: { tomar: () => Promise.resolve(randomUUID()), soltar: () => Promise.resolve() },
      }),
    });
    sinRedis.buscador.choferes = [randomUUID()];
    try {
      const encabezados = clave();
      const auth = await sinRedis.auth(randomUUID(), 'pasajero');
      const primera = await request(sinRedis.url).post('/solicitudes').set(encabezados).set(auth).send(cuerpo);
      expect(primera.status).toBe(201);
      // El pasajero cancela el primero: así el dominio no frena el segundo pedido y solo queda la clave primaria.
      await request(sinRedis.url).post(`/solicitudes/${primera.body.id}/cancelar`).set(clave()).set(auth).send({}).expect(200);

      const segunda = await request(sinRedis.url).post('/solicitudes').set(encabezados).set(auth).send(cuerpo);
      expect(segunda.status).toBe(409);
      expect(segunda.body.error.code).toBe('CLAVE_IDEMPOTENCIA_EN_CURSO');
      expect(await d.prisma.solicitudViaje.count()).toBe(1);
      expect(await eventos('RideRequested')).toBe(1);
    } finally {
      await sinRedis.cerrar();
    }
  });
});
