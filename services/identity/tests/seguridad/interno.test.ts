import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clave, CON_SERVICIO, CONTRASENA, datosRegistro, levantarIdentity, TOKEN_SERVICIO, type Identity } from '../soporte/sistema.js';

/**
 * `GET /interno/usuarios/:id`: solo para otros servicios (dispatch verifica que un chofer exista).
 * Exige el token de servicio, valida el id y devuelve el id y el rol, nada más.
 */
let d: Identity;

beforeAll(async () => {
  d = await levantarIdentity();
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
});

const consultar = (id: string) => request(d.url).get(`/interno/usuarios/${id}`);

describe('GET /interno/usuarios/:id', () => {
  it('con el token de servicio devuelve solo el id y el rol', async () => {
    const chofer = await request(d.url).post('/registro').set(clave()).send(datosRegistro({ email: 'beto@viajes.test', rol: 'chofer' })).expect(201);
    const res = await consultar(chofer.body.id).set(CON_SERVICIO);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: chofer.body.id, rol: 'chofer' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('una cuenta de pasajero devuelve su rol (quien pregunta decide)', async () => {
    const pasajero = await request(d.url).post('/registro').set(clave()).send(datosRegistro()).expect(201);
    expect((await consultar(pasajero.body.id).set(CON_SERVICIO)).body).toEqual({ id: pasajero.body.id, rol: 'pasajero' });
  });

  it('un id que no existe → 404', async () => {
    const res = await consultar(randomUUID()).set(CON_SERVICIO);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USUARIO_NO_ENCONTRADO');
  });

  it('sin token, con otro token o con el access token de un usuario → 401, el mismo mensaje', async () => {
    const pasajero = await request(d.url).post('/registro').set(clave()).send(datosRegistro()).expect(201);
    const login = await request(d.url).post('/login').send({ email: 'ana@viajes.test', contrasena: CONTRASENA }).expect(200);
    const intentos = [
      consultar(pasajero.body.id),
      consultar(pasajero.body.id).set('X-Token-Servicio', `${TOKEN_SERVICIO}x`),
      consultar(pasajero.body.id).set('Authorization', `Bearer ${login.body.token}`),
      consultar(pasajero.body.id).set('X-Token-Servicio', login.body.token),
    ];
    for (const res of await Promise.all(intentos)) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'TOKEN_SERVICIO_INVALIDO', message: 'Falta el token de servicio o no es válido' });
    }
  });

  it('un id que no es UUID → 400, también con el token', async () => {
    expect((await consultar('no-es-uuid').set(CON_SERVICIO)).status).toBe(400);
    expect((await consultar("1' OR '1'='1").set(CON_SERVICIO)).status).toBe(400);
  });
});
