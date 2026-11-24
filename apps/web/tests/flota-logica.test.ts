import { describe, expect, it } from 'vitest';
import { ErrorApi } from '../src/api/errores';
import {
  aplicarChofer,
  aplicarFlota,
  aplicarLecturaChofer,
  aplicarPagina,
  aplicarReporte,
  erroresAlta,
  LISTA_INICIAL,
  limiteRecarga,
  motivoSinActivar,
  mesEnCurso,
  objetivoAlta,
  pedirReporte,
  periodoDeFechas,
  REPORTE_INICIAL,
  textoErrorFlota,
  textoSinFacturar,
  vehiculoCoincide,
  type Chofer,
  type EstadoLista,
  type Periodo,
  type Reporte,
} from '../src/roles/flota/logica';

const FLOTA = '00000000-0000-4000-8000-0000000000f2';
const chofer = (n: number, cambios: Partial<Chofer> = {}): Chofer => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  flotaId: FLOTA,
  vehiculo: { patente: `AAA${String(n).padStart(3, '0')}`, marca: 'Fiat', modelo: 'Cronos' },
  habilitado: true,
  activo: false,
  disponible: false,
  ...cambios,
});
const flota = (activos: number, maxActivos = 2) => ({ id: FLOTA, nombre: 'Flota Norte', maxActivos, activos });

describe('lecturas atrasadas', () => {
  it('el cupo leído antes de la última mutación se descarta; el leído después se aplica', () => {
    let e: EstadoLista = { ...LISTA_INICIAL, flota: flota(0) };
    e = aplicarChofer(e, chofer(1, { activo: true }), 5);
    expect(aplicarFlota(e, flota(0), 4)).toEqual({ estado: e, descartada: true });
    expect(aplicarFlota(e, flota(1), 6).estado.flota?.activos).toBe(1);
  });

  it('una página que empezó antes de activar a un chofer no pisa esa fila, pero sí las demás', () => {
    let e = aplicarPagina(LISTA_INICIAL, { choferes: [chofer(1), chofer(2)], siguiente: null }, { inicio: 1, desde: 0 });
    e = aplicarChofer(e, chofer(1, { activo: true }), 5);
    // La página salió en 4 (antes de la respuesta de activar) y trae al 1 inactivo y al 2 con un cambio de otro.
    e = aplicarPagina(e, { choferes: [chofer(1), chofer(2, { disponible: true })], siguiente: null }, { inicio: 4, desde: 0 });
    expect(e.choferes.map((c) => [c.activo, c.disponible])).toEqual([
      [true, false],
      [false, true],
    ]);
    // Una lectura posterior sí se aplica, aunque traiga otro estado (por ejemplo, otro admin lo desactivó).
    e = aplicarPagina(e, { choferes: [chofer(1), chofer(2)], siguiente: null }, { inicio: 7, desde: 0 });
    expect(e.choferes[0]!.activo).toBe(false);
  });

  it('el GET de un chofer anterior a su mutación no la pisa', () => {
    let e = aplicarPagina(LISTA_INICIAL, { choferes: [chofer(1)], siguiente: null }, { inicio: 1, desde: 0 });
    e = aplicarChofer(e, chofer(1, { activo: true }), 5);
    expect(aplicarLecturaChofer(e, chofer(1), 3).choferes[0]!.activo).toBe(true);
    expect(aplicarLecturaChofer(e, chofer(1), 6).choferes[0]!.activo).toBe(false);
  });

  it('un alta hecha mientras se recargaba la lista no se pierde', () => {
    let e = aplicarPagina(LISTA_INICIAL, { choferes: [chofer(1)], siguiente: null }, { inicio: 1, desde: 0 });
    e = aplicarChofer(e, chofer(2), 5);
    e = aplicarPagina(e, { choferes: [chofer(1)], siguiente: null }, { inicio: 4, desde: 0 });
    expect(e.choferes.map((c) => c.id)).toEqual([chofer(1).id, chofer(2).id]);
  });
});

describe('paginación', () => {
  it('«Ver más» agrega al final sin repetir; un alta con páginas sin leer espera a su página', () => {
    let e = aplicarPagina(LISTA_INICIAL, { choferes: [chofer(1), chofer(2)], siguiente: 2 }, { inicio: 1, desde: 0 });
    e = aplicarChofer(e, chofer(3), 2);
    expect(e.choferes).toHaveLength(2);
    e = aplicarPagina(e, { choferes: [chofer(2), chofer(3)], siguiente: null }, { inicio: 3, desde: 2 });
    expect(e.choferes.map((c) => c.id)).toEqual([1, 2, 3].map((n) => chofer(n).id));
    expect(e.siguiente).toBeNull();
  });

  it('al recargar se piden las filas ya cargadas, sin pasar el máximo de la API', () => {
    expect(limiteRecarga(0)).toBe(10);
    expect(limiteRecarga(12)).toBe(20);
    expect(limiteRecarga(200)).toBe(50);
  });
});

describe('reglas y mensajes', () => {
  it('sin habilitación no se activa: la hace el admin de la plataforma', () => {
    expect(motivoSinActivar(chofer(1, { habilitado: false }))).toMatch(/admin de la plataforma/);
    expect(motivoSinActivar(chofer(1))).toBeNull();
  });

  it('el límite tiene un mensaje claro, con el número y cómo liberar un cupo', () => {
    const err = new ErrorApi(409, 'LIMITE_FLOTA_ALCANZADO', 'La flota ya tiene el máximo de choferes activos');
    expect(textoErrorFlota(err, flota(2))).toBe(
      'La flota llegó a su límite de 2 choferes activos. Para activar a otro, desactivá uno: así se libera un cupo.',
    );
  });

  it('el alta se valida como la API y el vehículo se compara normalizado', () => {
    const datos = { choferId: ' 00000000-0000-4000-8000-000000000001 ', vehiculo: { patente: 'aaa 001', marca: ' Fiat ', modelo: 'Cronos' } };
    expect(erroresAlta(datos)).toEqual({});
    expect(vehiculoCoincide(chofer(1), datos)).toBe(true);
    expect(vehiculoCoincide(chofer(1), { ...datos, vehiculo: { ...datos.vehiculo, modelo: 'Uno' } })).toBe(false);
    expect(Object.keys(erroresAlta({ choferId: 'x', vehiculo: { patente: 'A1', marca: '', modelo: 'm' } }))).toEqual(['choferId', 'patente', 'marca']);
    // La clave es por cuerpo: otro vehículo, otra operación.
    expect(objetivoAlta(datos)).not.toBe(objetivoAlta({ ...datos, vehiculo: { ...datos.vehiculo, patente: 'AAA002' } }));
  });
});

describe('reporte: el período', () => {
  const local = (a: number, m: number, d: number) => new Date(a, m - 1, d).toISOString();

  it('las dos fechas van incluidas: fin es la medianoche local del día siguiente a «hasta»', () => {
    expect(periodoDeFechas('2026-11-01', '2026-11-30')).toEqual({ periodo: { inicio: local(2026, 11, 1), fin: local(2026, 12, 1) } });
    expect(periodoDeFechas('2026-11-24', '2026-11-24')).toEqual({ periodo: { inicio: local(2026, 11, 24), fin: local(2026, 11, 25) } });
    expect(periodoDeFechas('2026-12-31', '2026-12-31')).toEqual({ periodo: { inicio: local(2026, 12, 31), fin: local(2027, 1, 1) } });
  });

  it('el mes en curso va del 1 a hoy', () => {
    expect(mesEnCurso(new Date(2026, 10, 24, 18, 30))).toEqual({ desde: '2026-11-01', hasta: '2026-11-24' });
    expect(mesEnCurso(new Date(2026, 0, 1, 0, 5))).toEqual({ desde: '2026-01-01', hasta: '2026-01-01' });
  });

  it('rechaza un rango al revés, de más de 366 días, o fechas vacías o inexistentes', () => {
    expect(periodoDeFechas('2026-11-02', '2026-11-01')).toHaveProperty('error');
    expect(periodoDeFechas('2025-01-01', '2026-01-02')).toHaveProperty('error'); // 367 días
    expect(periodoDeFechas('2025-01-01', '2026-01-01')).toHaveProperty('periodo'); // 366 justos
    expect(periodoDeFechas('2025-01-01', '2025-12-31')).toHaveProperty('periodo'); // 365
    expect(periodoDeFechas('2024-01-01', '2024-12-31')).toHaveProperty('periodo'); // 366, bisiesto
    expect(periodoDeFechas('', '2026-11-01')).toHaveProperty('error');
    expect(periodoDeFechas('2026-02-31', '2026-03-01')).toHaveProperty('error');
  });
});

describe('reporte: cada consulta con su marca', () => {
  const OCT: Periodo = { inicio: '2026-10-01T03:00:00.000Z', fin: '2026-11-01T03:00:00.000Z' };
  const NOV: Periodo = { inicio: '2026-11-01T03:00:00.000Z', fin: '2026-12-01T03:00:00.000Z' };
  const reporte = (p: Periodo, facturadoCentavos: number): Reporte => ({
    flotaId: FLOTA,
    ...p,
    moneda: 'ARS',
    viajesCompletados: facturadoCentavos > 0 ? 1 : 0,
    facturadoCentavos,
    cobros: {
      aprobados: { cantidad: facturadoCentavos > 0 ? 1 : 0, centavos: facturadoCentavos },
      pendientes: { cantidad: 0, centavos: 0 },
      rechazados: { cantidad: 0, centavos: 0 },
    },
  });

  it('con dos períodos pedidos seguidos, la respuesta vieja que llega tarde no pisa al último', () => {
    let e = pedirReporte(REPORTE_INICIAL, OCT, 1);
    e = pedirReporte(e, NOV, 2);
    e = aplicarReporte(e, { datos: reporte(NOV, 500) }, 2);
    const despues = aplicarReporte(e, { datos: reporte(OCT, 999) }, 1);
    expect(despues).toBe(e);
    expect(despues).toMatchObject({ periodo: NOV, datos: { facturadoCentavos: 500 }, cargando: false });
  });

  it('tampoco la pisa si la vieja llega antes, ni un error de una consulta vieja', () => {
    let e = pedirReporte(REPORTE_INICIAL, OCT, 1);
    e = pedirReporte(e, NOV, 2);
    e = aplicarReporte(e, { datos: reporte(OCT, 999) }, 1);
    e = aplicarReporte(e, { error: new ErrorApi(500, 'ERROR_INTERNO', 'x', null) }, 1);
    expect(e).toMatchObject({ periodo: NOV, datos: null, cargando: true, error: null });
    e = aplicarReporte(e, { datos: reporte(NOV, 0) }, 2);
    expect(e).toMatchObject({ datos: { facturadoCentavos: 0 }, cargando: false });
  });

  it('con otro período se dejan de mostrar los números anteriores; con el mismo, se conservan al releer', () => {
    let e = aplicarReporte(pedirReporte(REPORTE_INICIAL, OCT, 1), { datos: reporte(OCT, 100) }, 1);
    expect(pedirReporte(e, OCT, 2).datos).toMatchObject({ facturadoCentavos: 100 });
    e = pedirReporte(e, NOV, 3);
    expect(e.datos).toBeNull();
  });

  it('lo no facturado se informa con su monto', () => {
    const r = reporte(NOV, 1000);
    r.cobros.pendientes = { cantidad: 2, centavos: 25_050 };
    r.cobros.rechazados = { cantidad: 1, centavos: 700 };
    const texto = textoSinFacturar(r).replace(/\s/g, ' ');
    expect(texto).toContain('Pendientes de cobro: 2 ($ 250,50)');
    expect(texto).toContain('Rechazados: 1 ($ 7,00)');
  });
});
