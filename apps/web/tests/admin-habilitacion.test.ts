import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorApi } from '../src/api/errores';
import {
  agregarReciente,
  errorCodigo,
  normalizarCodigo,
  RECIENTES_MAX,
  textoErrorHabilitacion,
  textoHecho,
  type Chofer,
} from '../src/roles/admin/logica';

/**
 * La habilitación de choferes del admin: la lógica pura y el store real contra un servidor falso
 * detrás de `fetch`, con la idempotencia como la API (la misma clave repite la respuesta guardada).
 */

const FLOTA = '00000000-0000-4000-8000-0000000000f1';
const idDe = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const chofer = (n: number, cambios: Partial<Chofer> = {}): Chofer => ({
  id: idDe(n),
  flotaId: FLOTA,
  vehiculo: { patente: `AD${String(100 + n)}KM`, marca: 'Fiat', modelo: 'Cronos' },
  habilitado: false,
  activo: false,
  disponible: false,
  ...cambios,
});

describe('lógica', () => {
  it('normaliza el código: sin espacios y en minúsculas', () => {
    expect(normalizarCodigo('  426E8D80-6DA8-4DBC-9480-C8D39F9A9C37 \n')).toBe('426e8d80-6da8-4dbc-9480-c8d39f9a9c37');
  });

  it('valida el código antes de enviar', () => {
    expect(errorCodigo('')).toMatch(/Pegá el código/);
    expect(errorCodigo('426e8d80')).toMatch(/UUID/);
    expect(errorCodigo(' 426E8D80-6DA8-4DBC-9480-C8D39F9A9C37 ')).toBeNull();
  });

  it('traduce el 404: el chofer todavía no está en ninguna flota', () => {
    expect(textoErrorHabilitacion(new ErrorApi(404, 'CHOFER_NO_ENCONTRADO', ''))).toMatch(/no está en ninguna flota/);
  });

  it('dice qué pasó con el vehículo del chofer', () => {
    expect(textoHecho('habilitar', chofer(1, { habilitado: true }))).toBe('Habilitado: Fiat Cronos (AD101KM). Ya lo puede activar el admin de su flota.');
    expect(textoHecho('deshabilitar', chofer(1))).toMatch(/^Deshabilitado: Fiat Cronos \(AD101KM\)\. Quedó inactivo/);
  });

  it('los recientes: el último primero, sin repetir y con tope', () => {
    let r = agregarReciente([], chofer(1));
    r = agregarReciente(r, chofer(2));
    r = agregarReciente(r, chofer(1, { habilitado: true }));
    expect(r.map((c) => [c.id, c.habilitado])).toEqual([
      [idDe(1), true],
      [idDe(2), false],
    ]);
    for (let n = 3; n < 20; n++) r = agregarReciente(r, chofer(n));
    expect(r).toHaveLength(RECIENTES_MAX);
    expect(r[0]!.id).toBe(idDe(19));
  });
});

interface Servidor {
  choferes: Chofer[];
  guardadas: Map<string, { status: number; cuerpo: unknown }>;
  /** Las claves de cada POST que llegó, por ruta. */
  claves: Record<string, string[]>;
  /** La respuesta del próximo POST se pierde (el servidor sí lo aplica). */
  perderRespuesta: boolean;
}
let srv: Servidor;

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } });

function aplicar(ruta: string): { status: number; cuerpo: unknown } {
  const m = /^\/api\/viajes\/admin\/choferes\/([^/]+)\/(habilitar|deshabilitar)$/.exec(ruta);
  const c = m && srv.choferes.find((x) => x.id === m[1]);
  if (!m || !c) return { status: 404, cuerpo: { error: { code: 'CHOFER_NO_ENCONTRADO', message: '' } } };
  if (m[2] === 'habilitar') c.habilitado = true;
  else Object.assign(c, { habilitado: false, activo: false, disponible: false });
  return { status: 200, cuerpo: { ...c } };
}

async function servidorFalso(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const ruta = String(url);
  const clave = new Headers(init?.headers).get('idempotency-key') ?? '';
  (srv.claves[ruta] ??= []).push(clave);
  let r = srv.guardadas.get(clave);
  if (!r) {
    r = aplicar(ruta);
    if (r.status < 500) srv.guardadas.set(clave, r);
  }
  if (srv.perderRespuesta) {
    srv.perderRespuesta = false;
    throw new TypeError('Failed to fetch');
  }
  return json(r.cuerpo, r.status);
}

let useHabilitacion: typeof import('../src/roles/admin/store').useHabilitacion;

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(servidorFalso));
  const { useSesion } = await import('../src/sesion/store');
  useSesion.setState({ estado: 'activa', token: 'access', refreshToken: 'refresh', epoca: 1 });
  ({ useHabilitacion } = await import('../src/roles/admin/store'));
});

beforeEach(() => {
  srv = { choferes: [chofer(1), chofer(2, { habilitado: true, activo: true, disponible: true })], guardadas: new Map(), claves: {}, perderRespuesta: false };
  useHabilitacion.getState().reiniciar();
});

const esperarQuieto = () => vi.waitFor(() => expect(useHabilitacion.getState().operacion?.fase).not.toBe('enviando'));
const ruta = (n: number, accion: string) => `/api/viajes/admin/choferes/${idDe(n)}/${accion}`;

describe('store', () => {
  it('habilita con el código pegado y lo suma a los recientes', async () => {
    useHabilitacion.getState().enviar(` ${idDe(1).toUpperCase()} `, 'habilitar');
    await esperarQuieto();
    const s = useHabilitacion.getState();
    expect(s.operacion).toMatchObject({ fase: 'listo', accion: 'habilitar', choferId: idDe(1) });
    expect(s.recientes.map((c) => [c.id, c.habilitado])).toEqual([[idDe(1), true]]);
    expect(srv.choferes[0]!.habilitado).toBe(true);
  });

  it('deshabilitar deja al chofer inactivo y no disponible', async () => {
    useHabilitacion.getState().enviar(idDe(2), 'deshabilitar');
    await esperarQuieto();
    expect(useHabilitacion.getState().recientes[0]).toMatchObject({ habilitado: false, activo: false, disponible: false });
  });

  it('un chofer que no está en ninguna flota da un error definitivo y no queda en recientes', async () => {
    useHabilitacion.getState().enviar(idDe(9), 'habilitar');
    await esperarQuieto();
    const s = useHabilitacion.getState();
    expect(s.operacion?.fase).toBe('error');
    expect(textoErrorHabilitacion(s.operacion?.error)).toMatch(/ninguna flota/);
    expect(s.recientes).toEqual([]);
  });

  it('sin respuesta queda incierta; el reintento usa la MISMA clave y no la aplica dos veces', async () => {
    srv.perderRespuesta = true;
    useHabilitacion.getState().enviar(idDe(1), 'habilitar');
    await esperarQuieto();
    expect(useHabilitacion.getState().operacion?.fase).toBe('incierta');

    // Mientras está incierta, no se empieza otra.
    useHabilitacion.getState().enviar(idDe(2), 'deshabilitar');
    expect(useHabilitacion.getState().operacion).toMatchObject({ choferId: idDe(1), fase: 'incierta' });

    useHabilitacion.getState().reintentar();
    await esperarQuieto();
    expect(useHabilitacion.getState().operacion?.fase).toBe('listo');
    const claves = srv.claves[ruta(1, 'habilitar')]!;
    expect(claves).toHaveLength(2);
    expect(claves[0]).toBe(claves[1]);
    expect(srv.claves[ruta(2, 'deshabilitar')]).toBeUndefined();
  });

  it('descartar una incierta libera el formulario y la próxima vez usa otra clave', async () => {
    srv.perderRespuesta = true;
    useHabilitacion.getState().enviar(idDe(1), 'habilitar');
    await esperarQuieto();
    useHabilitacion.getState().descartar();
    expect(useHabilitacion.getState().operacion).toBeNull();

    useHabilitacion.getState().enviar(idDe(1), 'habilitar');
    await esperarQuieto();
    const claves = srv.claves[ruta(1, 'habilitar')]!;
    expect(claves).toHaveLength(2);
    expect(claves[0]).not.toBe(claves[1]);
  });
});
