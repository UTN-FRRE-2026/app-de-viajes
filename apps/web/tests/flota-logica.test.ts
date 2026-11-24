import { describe, expect, it } from 'vitest';
import { ErrorApi } from '../src/api/errores';
import {
  aplicarChofer,
  aplicarFlota,
  aplicarLecturaChofer,
  aplicarPagina,
  erroresAlta,
  LISTA_INICIAL,
  limiteRecarga,
  motivoSinActivar,
  objetivoAlta,
  textoErrorFlota,
  vehiculoCoincide,
  type Chofer,
  type EstadoLista,
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
