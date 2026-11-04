import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { verificadorJwks } from '@viajes/platform';
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sembrarUsuarios } from '../../src/infra/db/semilla.js';
import { EmisorJwt } from '../../src/infra/externos/emisor-jwt.js';
import { HasherArgon2 } from '../../src/infra/externos/hasher-argon2.js';
import { idsAleatorios, relojSistema } from '../../src/infra/externos/sistema.js';
import { AUDIENCE, CONTRASENA, datosRegistro, ISSUER, levantarIdentity, type Identity } from '../soporte/sistema.js';

// Prueba de caja negra: el dispatch REAL (su servidor, sus rutas y el verificador de platform) en
// un proceso aparte, bajando las claves del JWKS de identity por HTTP. No se importa su código:
// lo único que comparten es el contrato del token.
const CARPETA_DISPATCH = fileURLToPath(new URL('../../../dispatch', import.meta.url));
const cuerpo = { origen: { lat: -34.6, lng: -58.4 }, destino: { lat: -34.5, lng: -58.4 } };

let d: Identity;
let dispatch: ChildProcess;
let urlDispatch: string;
let salidaDispatch = '';

function puertoLibre(): Promise<number> {
  return new Promise((resolver, rechazar) => {
    const s = createServer();
    s.once('error', rechazar);
    s.listen(0, () => {
      const direccion = s.address();
      s.close(() => resolver(typeof direccion === 'object' && direccion ? direccion.port : 0));
    });
  });
}

async function esperarDispatch(url: string) {
  for (let i = 0; i < 150; i++) {
    if (dispatch.exitCode !== null) throw new Error(`dispatch terminó antes de arrancar:\n${salidaDispatch}`);
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {
      // Todavía no escucha.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`dispatch no arrancó a tiempo:\n${salidaDispatch}`);
}

async function tokenDe(email: string): Promise<string> {
  const res = await request(d.url).post('/login').send({ email, contrasena: CONTRASENA });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

const pedirViaje = (token: string) =>
  request(urlDispatch).post('/solicitudes').set('Authorization', `Bearer ${token}`).send(cuerpo);

beforeAll(async () => {
  d = await levantarIdentity();
  await d.limpiar();
  await request(d.url).post('/registro').send(datosRegistro()).expect(201);
  await request(d.url).post('/registro').send(datosRegistro({ email: 'beto@viajes.test', rol: 'chofer' })).expect(201);

  const puerto = await puertoLibre();
  urlDispatch = `http://127.0.0.1:${puerto}`;
  dispatch = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', 'src/servidor.ts'], {
    cwd: CARPETA_DISPATCH,
    env: {
      ...process.env,
      PUERTO: String(puerto),
      NIVEL_LOG: 'silent',
      DISPATCH_PERSISTENCIA: 'memoria',
      DISPATCH_CANDIDATOS_DEMO: '',
      JWKS_URL: `${d.url}/.well-known/jwks.json`,
      JWT_ISSUER: ISSUER,
      JWT_AUDIENCE: AUDIENCE,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  dispatch.stderr?.on('data', (parte: Buffer) => (salidaDispatch += parte.toString()));
  await esperarDispatch(urlDispatch);
});

afterAll(async () => {
  dispatch?.kill();
  await d?.cerrar();
});

describe('dispatch real acepta los tokens de identity', () => {
  it('un pasajero logueado pide un viaje a su nombre → 201', async () => {
    const token = await tokenDe('ana@viajes.test');
    const res = await pedirViaje(token);
    expect(res.status).toBe(201);
    const { id } = await d.prisma.usuario.findUniqueOrThrow({ where: { email: 'ana@viajes.test' } });
    expect(res.body.pasajeroId).toBe(id);
  });

  it('un chofer logueado se autentica pero su rol no puede pedir viajes → 403', async () => {
    const res = await pedirViaje(await tokenDe('beto@viajes.test'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROL_NO_PERMITIDO');
  });

  it('admin_flota: el verificador de platform lee fleetId desde el JWKS real', async () => {
    await sembrarUsuarios(d.prisma, new HasherArgon2(), CONTRASENA);
    const verificar = verificadorJwks(`${d.url}/.well-known/jwks.json`, { issuer: ISSUER, audience: AUDIENCE });
    const usuario = await verificar(await tokenDe('admin.flota@viajes.test'));
    expect(usuario).toMatchObject({ rol: 'admin_flota', fleetId: expect.any(String) });
    expect((await pedirViaje(await tokenDe('admin.flota@viajes.test'))).status).toBe(403);
  });
});

describe('dispatch real rechaza lo que no firmó identity', () => {
  const claveDeIdentity = () => d.config.IDENTITY_JWT_CLAVE_PRIVADA_B64;
  const opciones = { issuer: ISSUER, audience: AUDIENCE, ttlSegundos: 60 };
  const conEmisor = (cambios: Partial<typeof opciones>, reloj = relojSistema) =>
    new EmisorJwt(claveDeIdentity(), { ...opciones, ...cambios }, reloj, idsAleatorios).emitir({
      sub: randomUUID(),
      rol: 'pasajero',
    });

  it('sin token → 401', async () => {
    expect((await request(urlDispatch).post('/solicitudes').send(cuerpo)).status).toBe(401);
  });

  it('payload alterado (chofer que se pone rol pasajero) → 401', async () => {
    const [cabecera, carga, firma] = (await tokenDe('beto@viajes.test')).split('.');
    const claims = JSON.parse(Buffer.from(carga as string, 'base64url').toString());
    const alterada = Buffer.from(JSON.stringify({ ...claims, rol: 'pasajero' })).toString('base64url');
    expect((await pedirViaje(`${cabecera}.${alterada}.${firma}`)).status).toBe(401);
  });

  it('issuer distinto → 401', async () => {
    expect((await pedirViaje((await conEmisor({ issuer: 'otro-emisor' })).token)).status).toBe(401);
  });

  it('audience distinta → 401', async () => {
    expect((await pedirViaje((await conEmisor({ audience: 'otra-audiencia' })).token)).status).toBe(401);
  });

  it('token vencido → 401', async () => {
    const reloj = { ahora: () => new Date(Date.now() - 3_600_000) };
    expect((await pedirViaje((await conEmisor({}, reloj)).token)).status).toBe(401);
  });

  it('firmado con otra clave usando el kid de identity → 401', async () => {
    const respuesta = await request(d.url).get('/.well-known/jwks.json');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const falso = await new SignJWT({ rol: 'pasajero' })
      .setProtectedHeader({ alg: 'RS256', kid: respuesta.body.keys[0].kid })
      .setSubject(randomUUID())
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(privateKey);
    expect((await pedirViaje(falso)).status).toBe(401);
  });

  it('alg none → 401', async () => {
    const base64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const sinFirma = `${base64({ alg: 'none' })}.${base64({ sub: randomUUID(), rol: 'admin', iss: ISSUER, aud: AUDIENCE })}.`;
    expect((await pedirViaje(sinFirma)).status).toBe(401);
  });
});
