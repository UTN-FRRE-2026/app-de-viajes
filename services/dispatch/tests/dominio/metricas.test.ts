import { describe, expect, it } from 'vitest';
import { DESTINO, ORIGEN, sistemaEnMemoria, TTL_MS, uuids } from '../soporte/memoria.js';

const [PASAJERO, OTRO_PASAJERO] = uuids(2) as [string, string];
const pedir = (pasajeroId = PASAJERO) => ({ pasajeroId, origen: ORIGEN, destino: DESTINO });

describe('métricas de negocio de dispatch', () => {
  it('el tiempo hasta la asignación va desde antes de buscar candidatos hasta el COMMIT de la aceptación', async () => {
    const [chofer] = uuids(1) as [string];
    const sis = sistemaEnMemoria([chofer]);
    // La búsqueda en location tarda 300 ms: tiene que entrar en el tiempo medido.
    const buscar = sis.buscador.buscar.bind(sis.buscador);
    sis.buscador.buscar = async (origen, opciones) => {
      sis.reloj.avanzar(300);
      return buscar(origen, opciones);
    };

    const s = await sis.casos.crearSolicitud(pedir());
    sis.reloj.avanzar(1200);
    await sis.casos.aceptarOferta({ ofertaId: sis.ofertasDe(s.id)[0]!.id, choferId: chofer });

    expect(sis.metricas.solicitudes).toEqual(['con_ofertas']);
    expect(sis.metricas.asignaciones).toEqual([1500]);
  });

  it('creadaEn queda guardado pero no sale en los datos públicos de la solicitud', async () => {
    const sis = sistemaEnMemoria(uuids(1));
    const inicio = sis.reloj.ahora();
    const s = await sis.casos.crearSolicitud(pedir());

    expect(s).not.toHaveProperty('creadaEn');
    expect(await sis.casos.obtenerSolicitud({ solicitudId: s.id, usuarioId: PASAJERO, veTodas: false })).not.toHaveProperty(
      'creadaEn',
    );
    expect(sis.repo.solicitudes.get(s.id)?.creadaEn).toEqual(inicio);
  });

  it('sin candidatos cuenta la solicitud como sin_choferes', async () => {
    const sis = sistemaEnMemoria([]);
    await sis.casos.crearSolicitud(pedir());
    expect(sis.metricas.solicitudes).toEqual(['sin_choferes']);
    expect(sis.metricas.asignaciones).toEqual([]);
  });

  it('una solicitud rechazada (el pasajero ya tiene una activa) no se cuenta', async () => {
    const sis = sistemaEnMemoria(uuids(1));
    await sis.casos.crearSolicitud(pedir());
    await expect(sis.casos.crearSolicitud(pedir())).rejects.toMatchObject({ codigo: 'SOLICITUD_ACTIVA_EXISTENTE' });
    expect(sis.metricas.solicitudes).toEqual(['con_ofertas']);
  });

  it('de dos aceptaciones simultáneas sobre la misma solicitud, solo la ganadora se cuenta', async () => {
    const choferes = uuids(2) as [string, string];
    const sis = sistemaEnMemoria(choferes, 2);
    const s = await sis.casos.crearSolicitud(pedir());
    const [o1, o2] = sis.ofertasDe(s.id);

    const resultados = await Promise.allSettled([
      sis.casos.aceptarOferta({ ofertaId: o1!.id, choferId: choferes[0] }),
      sis.casos.aceptarOferta({ ofertaId: o2!.id, choferId: choferes[1] }),
    ]);
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(sis.metricas.asignaciones).toHaveLength(1);
  });

  it('una aceptación que hace rollback (chofer con viaje activo) no se cuenta', async () => {
    // Falla DESPUÉS de asignar en memoria y antes del COMMIT: si se registrara dentro de la transacción,
    // quedaría contada.
    const [chofer] = uuids(1) as [string];
    const sis = sistemaEnMemoria([chofer]);
    const s1 = await sis.casos.crearSolicitud(pedir(PASAJERO));
    const s2 = await sis.casos.crearSolicitud(pedir(OTRO_PASAJERO));
    await sis.casos.aceptarOferta({ ofertaId: sis.ofertasDe(s1.id)[0]!.id, choferId: chofer });

    await expect(
      sis.casos.aceptarOferta({ ofertaId: sis.ofertasDe(s2.id)[0]!.id, choferId: chofer }),
    ).rejects.toMatchObject({ codigo: 'CHOFER_CON_VIAJE_ACTIVO' });
    expect(sis.metricas.asignaciones).toHaveLength(1);
  });

  it('el barrido cuenta las ofertas vencidas', async () => {
    const sis = sistemaEnMemoria(uuids(4), 2);
    await sis.casos.crearSolicitud(pedir());
    sis.reloj.avanzar(TTL_MS);
    await sis.casos.vencerOfertas();
    expect(sis.metricas.vencidas).toEqual([2]);
  });

  it('antes del vencimiento, el barrido no cuenta nada', async () => {
    const sis = sistemaEnMemoria(uuids(2));
    await sis.casos.crearSolicitud(pedir());
    sis.reloj.avanzar(TTL_MS - 1);
    await sis.casos.vencerOfertas();
    expect(sis.metricas.vencidas).toEqual([]);
  });
});
