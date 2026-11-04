import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Reemplazos } from '../../src/composicion.js';
import { CONTRASENA, datosRegistro, levantarIdentity, type Identity } from '../soporte/sistema.js';

const MAX_EMAIL = 5;

let d: Identity;

beforeAll(async () => {
  d = await levantarIdentity({ config: { IDENTITY_LOGIN_MAX_POR_EMAIL: String(MAX_EMAIL) } });
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
  await request(d.url).post('/registro').send(datosRegistro()).expect(201);
});

const fallar = (url = d.url) => request(url).post('/login').send({ email: 'ana@viajes.test', contrasena: 'incorrecta-123' });
const entrar = (url = d.url) => request(url).post('/login').send({ email: 'ana@viajes.test', contrasena: CONTRASENA });

describe('límite por email', () => {
  it('el 6.º intento recibe 429 con Retry-After y RateLimit-*', async () => {
    for (let i = 1; i <= MAX_EMAIL; i++) {
      const res = await fallar();
      expect(res.status).toBe(401);
      expect(res.headers['ratelimit-limit']).toBe(String(MAX_EMAIL));
      expect(res.headers['ratelimit-remaining']).toBe(String(MAX_EMAIL - i));
    }

    const res = await fallar();
    expect(res.status).toBe(429);
    expect(res.body.error).toMatchObject({ code: 'DEMASIADOS_INTENTOS', requestId: expect.any(String) });
    expect(res.headers['ratelimit-remaining']).toBe('0');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(900);
    expect(res.headers['ratelimit-reset']).toBe(res.headers['retry-after']);
  });

  it('bloqueado, ni la contraseña correcta entra: no se verifica nada', async () => {
    for (let i = 0; i < MAX_EMAIL; i++) await fallar();
    expect((await entrar()).status).toBe(429);
  });

  it('cambiar mayúsculas o espacios del email no evade el límite', async () => {
    for (let i = 0; i < MAX_EMAIL; i++) await fallar();
    const res = await request(d.url).post('/login').send({ email: ' ANA@Viajes.test ', contrasena: 'incorrecta-123' });
    expect(res.status).toBe(429);
  });

  it('un login correcto reinicia el contador', async () => {
    for (let i = 0; i < MAX_EMAIL - 1; i++) await fallar();
    expect((await entrar()).status).toBe(200);
    expect((await fallar()).status).toBe(401);
    expect((await fallar()).headers['ratelimit-remaining']).toBe(String(MAX_EMAIL - 2));
  });

  it('X-Forwarded-For falso no evade ni el límite por email ni el contador por IP', async () => {
    for (let i = 0; i < MAX_EMAIL; i++) await fallar().set('X-Forwarded-For', `10.0.0.${i}`);
    expect((await fallar().set('X-Forwarded-For', '10.9.9.9')).status).toBe(429);
    const claves = await d.redis.keys('identity:login:ip:*');
    expect(claves).toHaveLength(1);
    expect(claves[0]).not.toContain('10.');
  });

  it('no guarda el email en Redis', async () => {
    await fallar();
    expect((await d.redis.keys('*')).join(' ')).not.toContain('ana@viajes.test');
  });

  it('una clave no queda sin vencimiento', async () => {
    await fallar();
    for (const clave of await d.redis.keys('identity:login:*')) {
      expect(await d.redis.pttl(clave)).toBeGreaterThan(0);
    }
  });

  it('un body inválido no consume intentos', async () => {
    await request(d.url).post('/login').send({ email: 'ana@viajes.test' }).expect(400);
    expect((await fallar()).headers['ratelimit-remaining']).toBe(String(MAX_EMAIL - 1));
  });
});

describe('límite por IP', () => {
  let porIp: Identity;

  beforeAll(async () => {
    porIp = await levantarIdentity({ config: { IDENTITY_LOGIN_MAX_POR_IP: '3' } });
  });
  afterAll(async () => {
    await porIp.cerrar();
  });

  it('corta a quien prueba muchos emails distintos', async () => {
    await d.redis.flushdb();
    const intentar = (n: number) =>
      request(porIp.url).post('/login').send({ email: `u${n}@viajes.test`, contrasena: 'incorrecta-123' });
    const estados = [];
    for (let i = 0; i < 4; i++) estados.push((await intentar(i)).status);
    expect(estados).toEqual([401, 401, 401, 429]);
  });
});

describe('si el límite no se puede consultar, falla cerrado', () => {
  let sinRedis: Identity;
  const llamadas = { verificar: 0 };

  beforeAll(async () => {
    const hasher: Reemplazos['hasher'] = {
      hashear: async () => 'x',
      verificar: async () => {
        llamadas.verificar += 1;
        return true;
      },
      simularVerificacion: async () => {
        llamadas.verificar += 1;
      },
    };
    sinRedis = await levantarIdentity({
      config: { REDIS_URL: 'redis://127.0.0.1:1/0' },
      reemplazos: { hasher },
    });
  });
  afterAll(async () => {
    await sinRedis.cerrar();
  });
  afterEach(() => {
    llamadas.verificar = 0;
  });

  it('login → 503 sin llegar a verificar la contraseña', async () => {
    const res = await request(sinRedis.url).post('/login').send({ email: 'ana@viajes.test', contrasena: CONTRASENA });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('LIMITE_NO_DISPONIBLE');
    expect(llamadas.verificar).toBe(0);
  });

  it('/ready → 503 e informa Redis', async () => {
    const res = await request(sinRedis.url).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.chequeos.redis).not.toBe('ok');
    expect(res.body.chequeos.postgres).toBe('ok');
  });
});
