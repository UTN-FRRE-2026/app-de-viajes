import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { crearCasosDeFlotas } from '../../src/dominio/casos-uso/flotas.js';
import { ChoferFlota } from '../../src/dominio/flotas/index.js';
import { RepositorioFlotasMemoria } from '../../src/infra/memoria/flotas-memoria.js';
import { RepositorioDespachoMemoria } from '../../src/infra/memoria/repositorio-memoria.js';
import { DirectorioFalso } from '../soporte/directorio-falso.js';
import { preparadorFlotas, vehiculo } from '../soporte/flotas.js';

describe('ChoferFlota: las reglas de estado', () => {
  const nuevo = () => ChoferFlota.nuevo(randomUUID(), randomUUID(), vehiculo());

  it('nace deshabilitado, inactivo y no disponible', () => {
    expect(nuevo().aDatos()).toMatchObject({ habilitado: false, activo: false, disponible: false });
  });

  it('activar exige habilitación; la primera vez ocupa cupo, la segunda no', () => {
    const c = nuevo();
    expect(() => c.activar()).toThrow(expect.objectContaining({ codigo: 'CHOFER_NO_HABILITADO' }));
    c.habilitar();
    expect(c.activar()).toBe('ocupa_cupo');
    expect(c.activar()).toBe('ya_activo');
  });

  it('desactivar y deshabilitar liberan el cupo solo si estaba activo, y lo dejan no disponible', () => {
    const c = nuevo();
    c.habilitar();
    expect(c.desactivar()).toBe(false);
    c.activar();
    c.cambiarDisponibilidad(true);
    expect(c.desactivar()).toBe(true);
    expect(c.aDatos()).toMatchObject({ activo: false, disponible: false, habilitado: true });
    c.activar();
    expect(c.deshabilitar()).toBe(true);
    expect(c.aDatos()).toMatchObject({ habilitado: false, activo: false, disponible: false });
    expect(c.deshabilitar()).toBe(false);
  });

  it('disponible exige estar activo; dejar de estarlo siempre se puede', () => {
    const c = nuevo();
    expect(() => c.cambiarDisponibilidad(true)).toThrow(expect.objectContaining({ codigo: 'CHOFER_NO_ACTIVO' }));
    c.cambiarDisponibilidad(false);
    expect(c.aDatos().disponible).toBe(false);
  });
});

describe('casos de uso de flotas: el alcance se valida en el caso de uso', () => {
  function sistema() {
    const repoFlotas = new RepositorioFlotasMemoria();
    const directorio = new DirectorioFalso();
    const casos = crearCasosDeFlotas({ repoFlotas, directorio, viajes: new RepositorioDespachoMemoria() });
    return { repoFlotas, directorio, casos, preparar: preparadorFlotas(casos, directorio) };
  }

  it('cada operación sobre un chofer de otra flota da 404, igual que uno inexistente', async () => {
    const { casos, preparar, repoFlotas } = sistema();
    const [a, b] = [await preparar.flota(3), await preparar.flota(3)];
    const [deB] = await preparar.choferes(b.id, 1);
    const actorA = { fleetId: a.id };
    for (const operacion of [
      () => casos.obtenerChofer(actorA, deB!),
      () => casos.activarChofer(actorA, deB!),
      () => casos.desactivarChofer(actorA, deB!),
      () => casos.activarChofer(actorA, randomUUID()),
    ]) {
      await expect(operacion()).rejects.toMatchObject({ codigo: 'CHOFER_NO_ENCONTRADO' });
    }
    expect(repoFlotas.flotas.get(b.id)?.activos).toBe(0);
  });

  it('sin fleetId en el token, 403; con una flota que no existe, 404', async () => {
    const { casos } = sistema();
    await expect(casos.flotaPropia({})).rejects.toMatchObject({ codigo: 'FLOTA_NO_ASIGNADA' });
    await expect(casos.activarChofer({}, randomUUID())).rejects.toMatchObject({ codigo: 'FLOTA_NO_ASIGNADA' });
    await expect(casos.flotaPropia({ fleetId: randomUUID() })).rejects.toMatchObject({ codigo: 'FLOTA_NO_ENCONTRADA' });
  });

  it('el alta pide la cuenta a identity: inexistente o de pasajero, 422; de chofer, se da de alta', async () => {
    const { casos, preparar, directorio, repoFlotas } = sistema();
    const flota = await preparar.flota(3);
    const actor = { fleetId: flota.id };
    await expect(casos.altaChofer(actor, { choferId: randomUUID(), vehiculo: vehiculo() })).rejects.toMatchObject({
      codigo: 'CUENTA_NO_ES_CHOFER',
    });
    const pasajero = directorio.registrar(randomUUID(), 'pasajero');
    await expect(casos.altaChofer(actor, { choferId: pasajero, vehiculo: vehiculo() })).rejects.toMatchObject({
      codigo: 'CUENTA_NO_ES_CHOFER',
    });
    expect(repoFlotas.choferes.size).toBe(0);
    const chofer = directorio.registrar(randomUUID(), 'chofer');
    expect(await casos.altaChofer(actor, { choferId: chofer, vehiculo: vehiculo() })).toMatchObject({ id: chofer, flotaId: flota.id });
  });

  it('el límite: el que no entra recibe 409 y el chofer no queda activo; desactivar libera', async () => {
    const { casos, preparar, repoFlotas } = sistema();
    const flota = await preparar.flota(1);
    const [c1, c2] = await preparar.choferes(flota.id, 2);
    const actor = { fleetId: flota.id };
    await casos.activarChofer(actor, c1!);
    await expect(casos.activarChofer(actor, c2!)).rejects.toMatchObject({ codigo: 'LIMITE_FLOTA_ALCANZADO' });
    expect(repoFlotas.choferes.get(c2!)?.activo).toBe(false);
    await casos.desactivarChofer(actor, c1!);
    expect(await casos.activarChofer(actor, c2!)).toMatchObject({ activo: true });
    expect(repoFlotas.flotas.get(flota.id)?.activos).toBe(1);
  });

  it('bajar el límite por debajo de los activos da 409', async () => {
    const { casos, preparar } = sistema();
    const flota = await preparar.flota(2);
    for (const c of await preparar.choferes(flota.id, 2)) await casos.activarChofer({ fleetId: flota.id }, c);
    await expect(casos.guardarFlota({ id: flota.id, nombre: 'X', maxActivos: 1 })).rejects.toMatchObject({
      codigo: 'LIMITE_MENOR_QUE_ACTIVOS',
    });
  });
});
