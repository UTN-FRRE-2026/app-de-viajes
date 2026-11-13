import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HasherArgon2 } from '../../src/infra/externos/hasher-argon2.js';
import { datosRegistro, levantarIdentity, type Identity } from '../soporte/sistema.js';

const MAX_EMAIL = 5;

/** argon2 real, contando cuántas veces se verificó una contraseña. */
class HasherContado extends HasherArgon2 {
  verificaciones = 0;

  override verificar(hash: string, contrasena: string) {
    this.verificaciones += 1;
    return super.verificar(hash, contrasena);
  }
}

const hasher = new HasherContado();
let d: Identity;

beforeAll(async () => {
  d = await levantarIdentity({ config: { IDENTITY_LOGIN_MAX_POR_EMAIL: String(MAX_EMAIL) }, reemplazos: { hasher } });
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
});

const contar = (estados: number[], estado: number) => estados.filter((e) => e === estado).length;

describe('concurrencia contra Postgres y Redis reales', () => {
  // Protección: el índice único de users.email. Sin él, este test falla.
  it('20 registros simultáneos con el mismo email → 1 gana y 19 reciben 409', async () => {
    const respuestas = await Promise.all(
      Array.from({ length: 20 }, () => request(d.url).post('/registro').send(datosRegistro())),
    );
    const estados = respuestas.map((r) => r.status);
    expect(contar(estados, 201)).toBe(1);
    expect(contar(estados, 409)).toBe(19);
    expect(await d.prisma.usuario.count()).toBe(1);
  });

  // Protección: el contador atómico ANTES de argon2. Las respuestas solas no alcanzan: si se
  // contara después de verificar darían igual, pero argon2 correría 50 veces.
  it('50 intentos simultáneos con contraseña mala → exactamente 5 llegan a verificar', async () => {
    await request(d.url).post('/registro').send(datosRegistro()).expect(201);
    const respuestas = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(d.url).post('/login').send({ email: 'ana@viajes.test', contrasena: 'incorrecta-123' }),
      ),
    );
    const estados = respuestas.map((r) => r.status);
    expect(contar(estados, 401)).toBe(MAX_EMAIL);
    expect(contar(estados, 429)).toBe(50 - MAX_EMAIL);
    expect(hasher.verificaciones).toBe(MAX_EMAIL);
  });

  // Protección: el UPDATE condicional sobre used_at. Con "leer y después marcar", varios pedidos
  // verían el token sin usar y cada uno sacaría su propia rama de la sesión.
  it('20 refresh simultáneos con el mismo token → 1 rota, 19 cuentan como reuso y la familia queda revocada', async () => {
    await request(d.url).post('/registro').send(datosRegistro()).expect(201);
    const { body: sesion } = await request(d.url)
      .post('/login')
      .send({ email: 'ana@viajes.test', contrasena: datosRegistro().contrasena })
      .expect(200);

    const respuestas = await Promise.all(
      Array.from({ length: 20 }, () => request(d.url).post('/refresh').send({ refreshToken: sesion.refreshToken })),
    );
    const estados = respuestas.map((r) => r.status);
    expect(contar(estados, 200)).toBe(1);
    expect(contar(estados, 401)).toBe(19);

    // Un solo token nuevo en la base, y revocado junto con el resto.
    expect(await d.prisma.refreshToken.count()).toBe(2);
    expect(await d.prisma.refreshToken.count({ where: { revocadoEn: null } })).toBe(0);
    const ganador = respuestas.find((r) => r.status === 200);
    const despues = await request(d.url).post('/refresh').send({ refreshToken: ganador?.body.refreshToken });
    expect(despues.status).toBe(401);
  });

  // Protección: el lock por familia que toman la rotación y la revocación. Sin él, la revocación
  // espera la fila del token que se está rotando y, al seguir, no ve el token recién creado:
  // revoca los viejos y el nuevo queda vivo, justo después de detectar un robo.
  it('reuso de un token viejo mientras se rota el actual → el token recién creado también queda revocado', async () => {
    await request(d.url).post('/registro').send(datosRegistro()).expect(201);
    const { body: a } = await request(d.url)
      .post('/login')
      .send({ email: 'ana@viajes.test', contrasena: datosRegistro().contrasena })
      .expect(200);
    const { body: b } = await request(d.url).post('/refresh').send({ refreshToken: a.refreshToken }).expect(200);

    // Solo en este test: cada INSERT tarda 1 s, así la rotación de B queda abierta el tiempo
    // suficiente para que el reuso de A llegue en el medio.
    await d.prisma.$executeRawUnsafe(`
      CREATE FUNCTION demora_test() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$`);
    await d.prisma.$executeRawUnsafe(
      'CREATE TRIGGER demora_test BEFORE INSERT ON refresh_tokens FOR EACH ROW EXECUTE FUNCTION demora_test()',
    );
    try {
      const rotacion = request(d.url).post('/refresh').send({ refreshToken: b.refreshToken }).then((r) => r);
      await new Promise((r) => setTimeout(r, 300));
      const reuso = await request(d.url).post('/refresh').send({ refreshToken: a.refreshToken });
      const rotada = await rotacion;

      expect(reuso.status).toBe(401);
      // La rotación había empezado antes: termina bien, pero su token nace en una familia revocada.
      expect(rotada.status).toBe(200);
      expect(await d.prisma.refreshToken.count()).toBe(3);
      expect(await d.prisma.refreshToken.count({ where: { revocadoEn: null } })).toBe(0);
      const despues = await request(d.url).post('/refresh').send({ refreshToken: rotada.body.refreshToken });
      expect(despues.status).toBe(401);
    } finally {
      await d.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS demora_test ON refresh_tokens');
      await d.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS demora_test()');
    }
  });
});
