import { randomUUID } from 'node:crypto';
import type { CerrojoEnVuelo } from '@viajes/platform';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { preparadorFlotas, vehiculo } from '../soporte/flotas.js';
import { clave, levantarDispatch } from '../soporte/sistema-postgres.js';

/** Flotas por HTTP contra Postgres: alcance, cupo, reglas, idempotencia y la cuenta en identity. */
let d: Awaited<ReturnType<typeof levantarDispatch>>;
let preparar: ReturnType<typeof preparadorFlotas>;

beforeAll(async () => {
  d = await levantarDispatch();
  preparar = preparadorFlotas(d.casosFlotas, d.directorio);
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiarFlotas();
});

const ADMIN = randomUUID();
const ADMIN_FLOTA = randomUUID();

const comoAdmin = () => d.auth(ADMIN, 'admin');
const comoFlota = (flotaId: string, usuario: string = ADMIN_FLOTA) => d.authFlota(usuario, flotaId);

async function accion(flotaId: string, choferId: string, que: 'activar' | 'desactivar', encabezados = clave(), usuario?: string) {
  return request(d.url)
    .post(`/flota/choferes/${choferId}/${que}`)
    .set(encabezados)
    .set(await comoFlota(flotaId, usuario))
    .send({});
}

const contador = async (flotaId: string) => (await d.prisma.flota.findUniqueOrThrow({ where: { id: flotaId } })).activos;
const chofer = (id: string) => d.prisma.choferFlota.findUniqueOrThrow({ where: { id } });

describe('aislamiento entre flotas: el alcance se valida en el caso de uso', () => {
  it('un admin_flota de A recibe 404 sobre un chofer de B, igual que si no existiera, y B no cambia', async () => {
    const [a, b] = [await preparar.flota(5), await preparar.flota(5)];
    const [deB] = await preparar.choferes(b.id, 1);
    await request(d.url).post(`/flota/choferes/${deB}/activar`).set(clave()).set(await comoFlota(b.id)).send({}).expect(200);

    const inexistente = await request(d.url).get(`/flota/choferes/${randomUUID()}`).set(await comoFlota(a.id));
    const ajenos = [
      await request(d.url).get(`/flota/choferes/${deB}`).set(await comoFlota(a.id)),
      await accion(a.id, deB!, 'activar'),
      await accion(a.id, deB!, 'desactivar'),
    ];
    for (const r of ajenos) {
      expect(r.status).toBe(404);
      expect(r.body.error).toMatchObject({ code: 'CHOFER_NO_ENCONTRADO', message: inexistente.body.error.message });
    }
    expect(await contador(b.id)).toBe(1);
    expect(await chofer(deB!)).toMatchObject({ activo: true });
  });

  it('el listado de una flota no muestra choferes de otra', async () => {
    const [a, b] = [await preparar.flota(5), await preparar.flota(5)];
    const deA = await preparar.choferes(a.id, 2);
    await preparar.choferes(b.id, 3);
    const res = await request(d.url).get('/flota/choferes').set(await comoFlota(a.id)).expect(200);
    expect(res.body.choferes.map((c: { id: string }) => c.id).sort()).toEqual([...deA].sort());
    expect(res.body.siguiente).toBeNull();
  });

  it('GET /flota devuelve la flota del token, con su contador', async () => {
    const a = await preparar.flota(4);
    const res = await request(d.url).get('/flota').set(await comoFlota(a.id)).expect(200);
    expect(res.body).toEqual({ id: a.id, nombre: a.nombre, maxActivos: 4, activos: 0 });
  });
});

describe('liberación del cupo', () => {
  it('con la flota llena, desactivar a uno libera su cupo y otro puede activarse', async () => {
    const flota = await preparar.flota(2);
    const [c1, c2, c3] = await preparar.choferes(flota.id, 3);
    expect((await accion(flota.id, c1!, 'activar')).status).toBe(200);
    expect((await accion(flota.id, c2!, 'activar')).status).toBe(200);
    const llena = await accion(flota.id, c3!, 'activar');
    expect(llena.status).toBe(409);
    expect(llena.body.error.code).toBe('LIMITE_FLOTA_ALCANZADO');
    expect(await chofer(c3!)).toMatchObject({ activo: false });

    expect((await accion(flota.id, c1!, 'desactivar')).status).toBe(200);
    expect(await contador(flota.id)).toBe(1);
    expect((await accion(flota.id, c3!, 'activar')).status).toBe(200);
    expect(await contador(flota.id)).toBe(2);
  });

  it('desactivar a un chofer inactivo no libera nada (el contador no baja de los activos)', async () => {
    const flota = await preparar.flota(2);
    const [c1, c2] = await preparar.choferes(flota.id, 2);
    await accion(flota.id, c1!, 'activar');
    expect((await accion(flota.id, c2!, 'desactivar')).status).toBe(200);
    expect(await contador(flota.id)).toBe(1);
  });

  it('el admin deshabilita a un chofer activo: queda inactivo y no disponible, y libera el cupo', async () => {
    const flota = await preparar.flota(1);
    const [c1, c2] = await preparar.choferes(flota.id, 2);
    await accion(flota.id, c1!, 'activar');
    await request(d.url).put('/chofer/disponibilidad').set(clave()).set(await d.auth(c1!, 'chofer')).send({ disponible: true }).expect(200);

    const res = await request(d.url).post(`/admin/choferes/${c1}/deshabilitar`).set(clave()).set(await comoAdmin()).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ habilitado: false, activo: false, disponible: false });
    expect(await contador(flota.id)).toBe(0);
    expect((await accion(flota.id, c2!, 'activar')).status).toBe(200);
  });

  it('bajar el límite por debajo de los activos da 409 y no cambia nada; igual o mayor, sí', async () => {
    const flota = await preparar.flota(3);
    for (const c of await preparar.choferes(flota.id, 2)) await accion(flota.id, c, 'activar');

    const baja = await request(d.url).put(`/admin/flotas/${flota.id}`).set(clave()).set(await comoAdmin()).send({ nombre: 'Otra', maxActivos: 1 });
    expect(baja.status).toBe(409);
    expect(baja.body.error.code).toBe('LIMITE_MENOR_QUE_ACTIVOS');
    expect(await d.prisma.flota.findUniqueOrThrow({ where: { id: flota.id } })).toMatchObject({ nombre: flota.nombre, maxActivos: 3, activos: 2 });

    const justa = await request(d.url).put(`/admin/flotas/${flota.id}`).set(clave()).set(await comoAdmin()).send({ nombre: 'Otra', maxActivos: 2 });
    expect(justa.status).toBe(200);
    expect(justa.body).toEqual({ id: flota.id, nombre: 'Otra', maxActivos: 2, activos: 2 });
  });
});

describe('reglas del chofer', () => {
  it('activar a un chofer no habilitado da 409 y no ocupa cupo', async () => {
    const flota = await preparar.flota(3);
    const [c] = await preparar.choferes(flota.id, 1, { habilitado: false });
    const res = await accion(flota.id, c!, 'activar');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHOFER_NO_HABILITADO');
    expect(await contador(flota.id)).toBe(0);
  });

  it('disponible exige estar activo; desactivar deja al chofer no disponible', async () => {
    const flota = await preparar.flota(3);
    const [c] = await preparar.choferes(flota.id, 1);
    const disponible = async (valor: boolean) =>
      request(d.url).put('/chofer/disponibilidad').set(clave()).set(await d.auth(c!, 'chofer')).send({ disponible: valor });

    const inactivo = await disponible(true);
    expect(inactivo.status).toBe(409);
    expect(inactivo.body.error.code).toBe('CHOFER_NO_ACTIVO');

    await accion(flota.id, c!, 'activar');
    expect((await disponible(true)).body).toMatchObject({ activo: true, disponible: true });
    await accion(flota.id, c!, 'desactivar');
    expect(await chofer(c!)).toMatchObject({ activo: false, disponible: false });
  });

  it('un chofer que no está en ninguna flota recibe 404 al cambiar su disponibilidad', async () => {
    const res = await request(d.url).put('/chofer/disponibilidad').set(clave()).set(await d.auth(randomUUID(), 'chofer')).send({ disponible: false });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CHOFER_NO_ENCONTRADO');
  });
});

describe('alta de chofer: la cuenta tiene que existir en identity y ser de chofer', () => {
  const alta = async (flotaId: string, choferId: string, patente = vehiculo().patente) =>
    request(d.url)
      .post('/flota/choferes')
      .set(clave())
      .set(await comoFlota(flotaId))
      .send({ choferId, vehiculo: { patente, marca: 'Fiat', modelo: 'Cronos' } });

  it('una cuenta de chofer se da de alta en la flota del token, deshabilitada e inactiva', async () => {
    const flota = await preparar.flota(3);
    const id = d.directorio.registrar(randomUUID(), 'chofer');
    const res = await alta(flota.id, id, 'ab 123 cd');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id,
      flotaId: flota.id,
      vehiculo: { patente: 'AB123CD', marca: 'Fiat', modelo: 'Cronos' },
      habilitado: false,
      activo: false,
      disponible: false,
    });
  });

  it('un UUID que no existe en identity y la cuenta de un pasajero se rechazan con 422, igual', async () => {
    const flota = await preparar.flota(3);
    const pasajero = d.directorio.registrar(randomUUID(), 'pasajero');
    const inexistente = await alta(flota.id, randomUUID());
    const dePasajero = await alta(flota.id, pasajero);
    for (const r of [inexistente, dePasajero]) {
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('CUENTA_NO_ES_CHOFER');
    }
    expect(dePasajero.body.error.message).toBe(inexistente.body.error.message);
    expect(await d.prisma.choferFlota.count()).toBe(0);
  });

  it('un chofer ya registrado en otra flota y una patente repetida dan 409', async () => {
    const [a, b] = [await preparar.flota(3), await preparar.flota(3)];
    const id = d.directorio.registrar(randomUUID(), 'chofer');
    const patente = vehiculo().patente;
    expect((await alta(a.id, id, patente)).status).toBe(201);
    const repetido = await alta(b.id, id);
    expect(repetido.status).toBe(409);
    expect(repetido.body.error.code).toBe('CHOFER_YA_REGISTRADO');
    const otra = await alta(b.id, d.directorio.registrar(randomUUID(), 'chofer'), patente);
    expect(otra.status).toBe(409);
    expect(otra.body.error.code).toBe('PATENTE_YA_REGISTRADA');
  });
});

describe('Idempotency-Key en las escrituras de flotas', () => {
  it('un reintento de la activación devuelve la respuesta guardada y no ocupa otro cupo', async () => {
    const flota = await preparar.flota(3);
    const [c] = await preparar.choferes(flota.id, 1);
    const encabezados = clave();
    const primera = await accion(flota.id, c!, 'activar', encabezados);
    const reintento = await accion(flota.id, c!, 'activar', encabezados);
    expect(reintento.status).toBe(200);
    expect(reintento.headers['idempotent-replayed']).toBe('true');
    expect(reintento.body).toEqual(primera.body);
    expect(await contador(flota.id)).toBe(1);
  });

  it('el alcance es por usuario y flota: con otra flota en el token, la misma clave no repite la respuesta', async () => {
    const [a, b] = [await preparar.flota(3), await preparar.flota(3)];
    const [deA] = await preparar.choferes(a.id, 1);
    const encabezados = clave();
    expect((await accion(a.id, deA!, 'activar', encabezados)).status).toBe(200);

    // El mismo usuario, ahora con la flota B en el token: se procesa de nuevo y el alcance da 404.
    const conOtraFlota = await accion(b.id, deA!, 'activar', encabezados);
    expect(conOtraFlota.status).toBe(404);
    expect(conOtraFlota.headers['idempotent-replayed']).toBeUndefined();
    // Otro usuario de la flota A con la misma clave tampoco recibe la respuesta del primero.
    const otroUsuario = await accion(a.id, deA!, 'activar', encabezados, randomUUID());
    expect(otroUsuario.headers['idempotent-replayed']).toBeUndefined();
  });

  it('la flota del token se valida antes de repetir: sin fleetId 403, y con una flota que no existe 404', async () => {
    const flota = await preparar.flota(3);
    const [c] = await preparar.choferes(flota.id, 1);
    const encabezados = clave();
    expect((await accion(flota.id, c!, 'activar', encabezados)).status).toBe(200);

    const sinFlota = await request(d.url)
      .post(`/flota/choferes/${c}/activar`).set(encabezados).set(await d.auth(ADMIN_FLOTA, 'admin_flota')).send({});
    expect(sinFlota.status).toBe(403);
    expect(sinFlota.body.error.code).toBe('FLOTA_NO_ASIGNADA');

    await d.prisma.$executeRawUnsafe('DELETE FROM drivers');
    await d.prisma.$executeRawUnsafe(`DELETE FROM fleets WHERE id = '${flota.id}'`);
    const flotaBorrada = await accion(flota.id, c!, 'activar', encabezados);
    expect(flotaBorrada.status).toBe(404);
    expect(flotaBorrada.body.error.code).toBe('FLOTA_NO_ENCONTRADA');
    expect(flotaBorrada.headers['idempotent-replayed']).toBeUndefined();
  });

  it('PUT /admin/flotas/:id y PUT /chofer/disponibilidad exigen la clave y guardan la respuesta', async () => {
    const id = randomUUID();
    const sinClave = await request(d.url).put(`/admin/flotas/${id}`).set(await comoAdmin()).send({ nombre: 'Norte', maxActivos: 2 });
    expect(sinClave.status).toBe(400);
    expect(sinClave.body.error.code).toBe('CLAVE_IDEMPOTENCIA_INVALIDA');

    const encabezados = clave();
    const creada = await request(d.url).put(`/admin/flotas/${id}`).set(encabezados).set(await comoAdmin()).send({ nombre: 'Norte', maxActivos: 2 });
    expect(creada.status).toBe(200);
    const registro = await d.prisma.registroIdempotencia.findFirstOrThrow({ where: { clave: encabezados['Idempotency-Key'] } });
    expect(registro).toMatchObject({ alcance: ADMIN, estado: 200, respuesta: creada.body });

    const [c] = await preparar.choferes(id, 1);
    await accion(id, c!, 'activar');
    const sinClaveChofer = await request(d.url).put('/chofer/disponibilidad').set(await d.auth(c!, 'chofer')).send({ disponible: true });
    expect(sinClaveChofer.status).toBe(400);
  });
});

describe('el resultado se guarda en la misma transacción que el cambio', () => {
  // Un cerrojo que deja pasar todo: como si el de Redis hubiera vencido con el pedido en curso. Lo que
  // impide el segundo registro es la clave primaria de idempotency_keys, dentro de la transacción.
  const sinCerrojo: CerrojoEnVuelo = { tomar: async () => randomUUID(), soltar: async () => {} };
  let s: Awaited<ReturnType<typeof levantarDispatch>>;
  beforeAll(async () => {
    s = await levantarDispatch({ idempotencia: (reales) => ({ ...reales, cerrojo: sinCerrojo }) });
  });
  afterAll(async () => {
    await s.cerrar();
  });

  it('10 PUT /admin/flotas/:id simultáneos con la misma clave: uno confirma, el resto 409, una sola clave', async () => {
    const id = randomUUID();
    const encabezados = clave();
    const admin = await s.auth(ADMIN, 'admin');
    const respuestas = await Promise.all(
      Array.from({ length: 10 }, () => request(s.url).put(`/admin/flotas/${id}`).set(encabezados).set(admin).send({ nombre: 'Sur', maxActivos: 4 })),
    );
    const codigos = respuestas.map((r) => r.status);
    expect(codigos.filter((c) => c === 409).length + codigos.filter((c) => c === 200).length).toBe(10);
    expect(await s.prisma.registroIdempotencia.count({ where: { clave: encabezados['Idempotency-Key'] } })).toBe(1);
    // Cada 200 es el que registró o una repetición de ese registro; ningún otro confirmó.
    const confirmadas = respuestas.filter((r) => r.status === 200 && r.headers['idempotent-replayed'] !== 'true');
    expect(confirmadas).toHaveLength(1);
  });

  it('10 PUT /chofer/disponibilidad simultáneos con la misma clave: uno solo confirma', async () => {
    const preparar2 = preparadorFlotas(s.casosFlotas, s.directorio);
    const flota = await preparar2.flota(2);
    const [c] = await preparar2.choferes(flota.id, 1);
    await s.casosFlotas.activarChofer({ fleetId: flota.id }, c!);
    const encabezados = clave();
    const chofer = await s.auth(c!, 'chofer');
    const respuestas = await Promise.all(
      Array.from({ length: 10 }, () => request(s.url).put('/chofer/disponibilidad').set(encabezados).set(chofer).send({ disponible: true })),
    );
    const confirmadas = respuestas.filter((r) => r.status === 200 && r.headers['idempotent-replayed'] !== 'true');
    expect(confirmadas).toHaveLength(1);
    expect(await s.prisma.registroIdempotencia.count({ where: { clave: encabezados['Idempotency-Key'] } })).toBe(1);
  });
});

describe('restricciones de la base', () => {
  it('el CHECK impide que el contador pase el límite o baje de cero', async () => {
    const flota = await preparar.flota(1);
    await expect(d.prisma.$executeRawUnsafe(`UPDATE fleets SET active_count = 2 WHERE id = '${flota.id}'`)).rejects.toThrow(/fleets_cupo_check/);
    await expect(d.prisma.$executeRawUnsafe(`UPDATE fleets SET active_count = -1 WHERE id = '${flota.id}'`)).rejects.toThrow(/fleets_cupo_check/);
  });

  it('activo sin habilitación y disponible sin estar activo se rechazan', async () => {
    const flota = await preparar.flota(3);
    const [c] = await preparar.choferes(flota.id, 1, { habilitado: false });
    await expect(d.prisma.$executeRawUnsafe(`UPDATE drivers SET active = true WHERE id = '${c}'`)).rejects.toThrow(/drivers_activo_habilitado_check/);
    await expect(d.prisma.$executeRawUnsafe(`UPDATE drivers SET available = true WHERE id = '${c}'`)).rejects.toThrow(/drivers_disponible_activo_check/);
  });
});
