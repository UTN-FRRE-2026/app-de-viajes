import { describe, expect, it } from 'vitest';
import { calcularTarifa } from '../../src/dominio/tarifas/calculo.js';
import { PARAMETROS_PRUEBA } from '../soporte/mapas-falso.js';
import { DESTINO, ORIGEN, sistemaEnMemoria, uuids } from '../soporte/memoria.js';

/**
 * PR 3 de tarifas, en memoria. Con PARAMETROS_PRUEBA y el recorrido del mapas falso (5000 m, 600 s):
 *   estimada = 100 000 + 5 km × 50 000 + 10 min × 10 000 = 450 000 centavos.
 */
const ESTIMADA = 450_000;

/** Un viaje en curso, iniciado en el reloj falso. */
async function viajeEnCurso() {
  const [pasajero, chofer] = uuids(2) as [string, string];
  const sis = sistemaEnMemoria([chofer]);
  const s = await sis.casos.crearSolicitud({ pasajeroId: pasajero, origen: ORIGEN, destino: DESTINO });
  await sis.casos.aceptarOferta({ ofertaId: sis.ofertasDe(s.id)[0]!.id, choferId: chofer });
  const entrada = { solicitudId: s.id, choferId: chofer };
  await sis.casos.marcarEnCamino(entrada);
  await sis.casos.iniciarViaje(entrada);
  return { ...sis, s, pasajero, chofer, entrada };
}

/** Viaje completado después de `segundos` reales de viaje. */
async function viajeCompletado(segundos = 600) {
  const v = await viajeEnCurso();
  v.reloj.avanzar(segundos * 1000);
  const final = await v.casos.finalizarViaje(v.entrada);
  return { ...v, final };
}

describe('estimación guardada al crear la solicitud', () => {
  it('guarda la misma estimación que GET /tarifas/estimacion, con su versión', async () => {
    const { casos } = sistemaEnMemoria(uuids(1));
    const estimacion = await casos.estimarTarifa({ origen: ORIGEN, destino: DESTINO });
    const s = await casos.crearSolicitud({ pasajeroId: uuids(1)[0]!, origen: ORIGEN, destino: DESTINO });

    expect(estimacion.tarifaCentavos).toBe(ESTIMADA);
    expect(s.tarifa).toEqual({
      version: estimacion.tarifaVersion,
      moneda: 'ARS',
      estimadaCentavos: estimacion.tarifaCentavos,
      recorridoEstimado: { metros: estimacion.distanciaMetros, segundos: estimacion.duracionSegundos },
      finalCentavos: null,
      recorridoFinal: null,
      motivosDiferencia: [],
    });
  });

  it('un recorrido de más del máximo no se crea: 422 y no se busca chofer', async () => {
    const { casos, mapas, buscador, repo } = sistemaEnMemoria(uuids(1));
    mapas.modo = { recorrido: { metros: PARAMETROS_PRUEBA.maxMetros + 1, segundos: 3600 } };
    const buscar = buscador.buscar.bind(buscador);
    let busquedas = 0;
    buscador.buscar = (...a) => (busquedas++, buscar(...a));

    await expect(casos.crearSolicitud({ pasajeroId: uuids(1)[0]!, origen: ORIGEN, destino: DESTINO })).rejects.toMatchObject({
      codigo: 'VIAJE_FUERA_DE_RANGO',
    });
    expect(repo.solicitudes.size).toBe(0);
    expect(busquedas).toBe(0);
  });

  it('justo en el máximo, sí se crea', async () => {
    const { casos, mapas } = sistemaEnMemoria(uuids(1));
    mapas.modo = { recorrido: { metros: PARAMETROS_PRUEBA.maxMetros, segundos: 3600 } };
    const s = await casos.crearSolicitud({ pasajeroId: uuids(1)[0]!, origen: ORIGEN, destino: DESTINO });
    expect(s.estado).toBe('BUSCANDO');
  });

  it('sin mapas no hay viaje: falla cerrado y no se crea nada', async () => {
    const { casos, mapas, repo } = sistemaEnMemoria(uuids(1));
    mapas.modo = 'falla';
    await expect(casos.crearSolicitud({ pasajeroId: uuids(1)[0]!, origen: ORIGEN, destino: DESTINO })).rejects.toThrow();
    expect(repo.solicitudes.size).toBe(0);
  });
});

describe('tarifa final', () => {
  it('con la duración estimada exacta, el final es igual al estimado y no hay motivos', async () => {
    const { final } = await viajeCompletado(600);
    expect(final.tarifa).toMatchObject({
      estimadaCentavos: ESTIMADA,
      finalCentavos: ESTIMADA,
      recorridoFinal: { metros: 5000, segundos: 600 },
      motivosDiferencia: [],
    });
  });

  it('el viaje tardó más: la duración real (de iniciar a finalizar) sube el importe, con motivo DURACION', async () => {
    const { final } = await viajeCompletado(900);
    // 100 000 + 250 000 + 15 min × 10 000
    expect(final.tarifa).toMatchObject({
      finalCentavos: 500_000,
      recorridoFinal: { metros: 5000, segundos: 900 },
      motivosDiferencia: ['DURACION'],
    });
  });

  it('usa la misma calcularTarifa que la estimación', async () => {
    const { final } = await viajeCompletado(1234);
    const esperado = calcularTarifa(PARAMETROS_PRUEBA, { metros: 5000, segundos: 1234 }).totalCentavos;
    expect(final.tarifa?.finalCentavos).toBe(esperado);
  });

  it('la duración se redondea al segundo', async () => {
    const v = await viajeEnCurso();
    v.reloj.avanzar(600_499);
    expect((await v.casos.finalizarViaje(v.entrada)).tarifa?.recorridoFinal?.segundos).toBe(600);
  });

  it('distinto recorrido pero mismo importe (los dos en el mínimo): sin motivos, porque el importe no cambió', async () => {
    const [pasajero, chofer] = uuids(2) as [string, string];
    const sis = sistemaEnMemoria([chofer]);
    sis.tarifas.cambiar({ ...PARAMETROS_PRUEBA, version: 'minimo-alto', minimoCentavos: 5_000_000 });
    const s = await sis.casos.crearSolicitud({ pasajeroId: pasajero, origen: ORIGEN, destino: DESTINO });
    await sis.casos.aceptarOferta({ ofertaId: sis.ofertasDe(s.id)[0]!.id, choferId: chofer });
    const entrada = { solicitudId: s.id, choferId: chofer };
    await sis.casos.marcarEnCamino(entrada);
    await sis.casos.iniciarViaje(entrada);
    sis.reloj.avanzar(2000 * 1000);
    const final = await sis.casos.finalizarViaje(entrada);
    expect(final.tarifa).toMatchObject({ estimadaCentavos: 5_000_000, finalCentavos: 5_000_000, motivosDiferencia: [] });
  });

  it('precio congelado: si el admin cambia la tarifa durante el viaje, el final usa la versión de la estimación', async () => {
    const v = await viajeEnCurso();
    v.tarifas.cambiar({ ...PARAMETROS_PRUEBA, version: 'prueba-2', bajadaCentavos: 900_000, centavosPorKm: 900_000 });
    v.reloj.avanzar(600 * 1000);
    const final = await v.casos.finalizarViaje(v.entrada);
    expect(final.tarifa).toMatchObject({ version: PARAMETROS_PRUEBA.version, finalCentavos: ESTIMADA, motivosDiferencia: [] });
  });

  it('la estimación no cambia al finalizar', async () => {
    const { final, s } = await viajeCompletado(900);
    expect(final.tarifa?.estimadaCentavos).toBe(s.tarifa?.estimadaCentavos);
    expect(final.tarifa?.recorridoEstimado).toEqual(s.tarifa?.recorridoEstimado);
  });

  it('un viaje cancelado no tiene tarifa final ni cobro', async () => {
    const v = await viajeEnCurso();
    const cancelada = await v.casos.cancelarSolicitud({
      solicitudId: v.s.id,
      usuarioId: uuids(1)[0]!,
      quien: 'operador',
      motivo: 'reclamo',
    });
    expect(cancelada.tarifa?.finalCentavos).toBeNull();
    expect(v.repo.cobros.size).toBe(0);
  });
});

describe('cobro', () => {
  it('finalizar crea un cobro PENDIENTE por la tarifa final, en la misma transacción', async () => {
    const { repo, s, pasajero, pagos } = await viajeCompletado(900);
    const cobro = await repo.obtenerCobro(s.id);
    expect(cobro?.aDatos()).toMatchObject({
      solicitudId: s.id,
      pasajeroId: pasajero,
      montoCentavos: 500_000,
      estado: 'PENDIENTE',
      intentosFallidos: 0,
    });
    // Finalizar no llama al proveedor: eso lo hace el barrido o POST /cobrar, fuera de la transacción.
    expect(pagos.llamadas).toHaveLength(0);
  });

  it('cobrar aprueba y registra PaymentCaptured; volver a cobrar devuelve lo mismo sin llamar al proveedor', async () => {
    const { casos, s, pasajero, pagos, repo } = await viajeCompletado();
    const primero = await casos.cobrarViaje({ solicitudId: s.id, usuarioId: pasajero, veTodos: false });
    expect(primero).toMatchObject({ estado: 'APROBADO', montoCentavos: ESTIMADA, referencia: expect.any(String) });

    const segundo = await casos.cobrarViaje({ solicitudId: s.id, usuarioId: pasajero, veTodos: false });
    expect(segundo).toEqual(primero);
    expect(pagos.llamadas).toHaveLength(1);
    expect(pagos.llamadas[0]?.clave).toBe(primero.id);
    expect(repo.eventos.filter((e) => e.tipo === 'PaymentCaptured')).toHaveLength(1);
  });

  it('proveedor caído: el cobro sigue PENDIENTE (falla cerrado), se anota el intento y el barrido lo cobra después', async () => {
    const { casos, s, pasajero, pagos, repo } = await viajeCompletado();
    pagos.modo = 'falla';
    await expect(casos.cobrarViaje({ solicitudId: s.id, usuarioId: pasajero, veTodos: false })).rejects.toThrow();
    expect((await repo.obtenerCobro(s.id))?.aDatos()).toMatchObject({ estado: 'PENDIENTE', intentosFallidos: 1 });
    expect(await casos.cobrarPendientes()).toBe(0);
    expect((await repo.obtenerCobro(s.id))?.aDatos().intentosFallidos).toBe(2);

    pagos.modo = 'aprueba';
    expect(await casos.cobrarPendientes()).toBe(1);
    expect((await repo.obtenerCobro(s.id))?.estado).toBe('APROBADO');
    expect(pagos.cobrados.size).toBe(1);
  });

  it('un cobro que sigue fallando no traba a los demás: pasa al final de la cola del barrido', async () => {
    const [chofer, ...pasajeros] = uuids(4) as [string, string, string, string];
    const sis = sistemaEnMemoria([chofer]);
    const ids: string[] = [];
    for (const pasajeroId of pasajeros) {
      const s = await sis.casos.crearSolicitud({ pasajeroId, origen: ORIGEN, destino: DESTINO });
      await sis.casos.aceptarOferta({ ofertaId: sis.ofertasDe(s.id)[0]!.id, choferId: chofer });
      const entrada = { solicitudId: s.id, choferId: chofer };
      await sis.casos.marcarEnCamino(entrada);
      await sis.casos.iniciarViaje(entrada);
      await sis.casos.finalizarViaje(entrada);
      ids.push(s.id);
    }
    // Los dos cobros más viejos fallan siempre; el barrido toma de a 2.
    sis.pagos.fallanPasajeros.add(pasajeros[0]).add(pasajeros[1]);
    expect(await sis.casos.cobrarPendientes(2)).toBe(0);
    // Ordenando por creación volvería a tomar los mismos dos y el tercero no se cobraría nunca.
    expect(await sis.casos.cobrarPendientes(2)).toBe(1);
    expect((await sis.repo.obtenerCobro(ids[2]!))?.estado).toBe('APROBADO');

    sis.pagos.fallanPasajeros.clear();
    expect(await sis.casos.cobrarPendientes(2)).toBe(2);
    expect(sis.pagos.cobrados.size).toBe(3);
  });

  it('rechazado: queda RECHAZADO con el motivo y PaymentDeclined, y no se reintenta', async () => {
    const { casos, s, pasajero, pagos, repo } = await viajeCompletado();
    pagos.modo = 'rechaza';
    const cobro = await casos.cobrarViaje({ solicitudId: s.id, usuarioId: pasajero, veTodos: false });
    expect(cobro).toMatchObject({ estado: 'RECHAZADO', motivoRechazo: 'tarjeta rechazada' });
    expect(repo.eventos.filter((e) => e.tipo === 'PaymentDeclined')).toHaveLength(1);
    expect(await casos.cobrarPendientes()).toBe(0);
    expect(pagos.llamadas).toHaveLength(1);
  });

  it('el cobro de otro pasajero responde como inexistente; el operador puede cobrarlo', async () => {
    const { casos, s } = await viajeCompletado();
    await expect(casos.cobrarViaje({ solicitudId: s.id, usuarioId: uuids(1)[0]!, veTodos: false })).rejects.toMatchObject({
      codigo: 'COBRO_NO_ENCONTRADO',
    });
    expect(await casos.cobrarViaje({ solicitudId: s.id, usuarioId: uuids(1)[0]!, veTodos: true })).toMatchObject({
      estado: 'APROBADO',
    });
  });

  it('un viaje sin completar no tiene cobro', async () => {
    const { casos, s, pasajero } = await viajeEnCurso();
    await expect(casos.cobrarViaje({ solicitudId: s.id, usuarioId: pasajero, veTodos: false })).rejects.toMatchObject({
      codigo: 'COBRO_NO_ENCONTRADO',
    });
  });

  it('el pedido y el barrido a la vez: el proveedor cobra una vez y se registra un solo resultado', async () => {
    const { casos, s, pasajero, pagos, repo } = await viajeCompletado();
    pagos.modo = { demoraMs: 20 };
    const resultados = await Promise.all([
      ...Array.from({ length: 5 }, () => casos.cobrarViaje({ solicitudId: s.id, usuarioId: pasajero, veTodos: false })),
      casos.cobrarPendientes(),
    ]);
    expect(pagos.cobrados.size).toBe(1);
    expect(repo.eventos.filter((e) => e.tipo === 'PaymentCaptured')).toHaveLength(1);
    expect(new Set(resultados.slice(0, 5).map((r) => (r as { referencia: string }).referencia)).size).toBe(1);
  });

  it('el detalle del viaje trae el cobro', async () => {
    const { casos, s, pasajero } = await viajeCompletado();
    expect((await casos.obtenerSolicitud({ solicitudId: s.id, usuarioId: pasajero, veTodas: false })).cobro).toMatchObject({
      estado: 'PENDIENTE',
    });
    await casos.cobrarViaje({ solicitudId: s.id, usuarioId: pasajero, veTodos: false });
    expect((await casos.obtenerSolicitud({ solicitudId: s.id, usuarioId: pasajero, veTodas: false })).cobro).toMatchObject({
      estado: 'APROBADO',
    });
  });
});
