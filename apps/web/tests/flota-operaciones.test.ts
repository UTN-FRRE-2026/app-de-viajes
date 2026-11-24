import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chofer, DatosAlta } from '../src/roles/flota/logica';

/**
 * El store real del panel de la flota contra un servidor falso detrás de `fetch`, con la idempotencia
 * como la API: la misma clave repite la respuesta guardada, sin volver a aplicar el cambio.
 */

const FLOTA = '00000000-0000-4000-8000-0000000000f2';
const idDe = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Servidor {
  maxActivos: number;
  choferes: Chofer[];
  /** Respuestas guardadas por Idempotency-Key. */
  guardadas: Map<string, { status: number; cuerpo: unknown }>;
  /** Las claves de cada POST que llegó, por ruta. */
  claves: Record<string, string[]>;
  /** La respuesta del próximo POST se pierde (el servidor sí lo aplica). */
  perderRespuesta: boolean;
  /** El GET de un chofer todavía no ve el cambio (por ejemplo, una réplica atrasada). */
  lecturaAtrasada: boolean;
  /** Antes del cambio, para la lectura atrasada. */
  anterior: Map<string, Chofer>;
}
let srv: Servidor;

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } });
const error = (status: number, code: string) => json({ error: { code, message: code } }, status);
const activos = () => srv.choferes.filter((c) => c.activo).length;

function aplicar(ruta: string, cuerpo: unknown): { status: number; cuerpo: unknown } {
  if (ruta === '/api/viajes/flota/choferes') {
    const d = cuerpo as DatosAlta;
    if (srv.choferes.some((c) => c.id === d.choferId)) return { status: 409, cuerpo: { error: { code: 'CHOFER_YA_REGISTRADO', message: '' } } };
    const c: Chofer = { id: d.choferId, flotaId: FLOTA, vehiculo: d.vehiculo, habilitado: false, activo: false, disponible: false };
    srv.choferes.push(c);
    return { status: 201, cuerpo: c };
  }
  const m = /^\/api\/viajes\/flota\/choferes\/([^/]+)\/(activar|desactivar)$/.exec(ruta);
  const c = m && srv.choferes.find((x) => x.id === m[1]);
  if (!m || !c) return { status: 404, cuerpo: { error: { code: 'CHOFER_NO_ENCONTRADO', message: '' } } };
  srv.anterior.set(c.id, { ...c });
  if (m[2] === 'activar' && !c.activo) {
    if (!c.habilitado) return { status: 409, cuerpo: { error: { code: 'CHOFER_NO_HABILITADO', message: '' } } };
    if (activos() >= srv.maxActivos) return { status: 409, cuerpo: { error: { code: 'LIMITE_FLOTA_ALCANZADO', message: '' } } };
    c.activo = true;
  }
  if (m[2] === 'desactivar') Object.assign(c, { activo: false, disponible: false });
  return { status: 200, cuerpo: { ...c } };
}

async function servidorFalso(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const [ruta, query] = String(url).split('?');
  const metodo = init?.method ?? 'GET';
  if (metodo === 'GET') {
    if (ruta === '/api/viajes/flota') return json({ id: FLOTA, nombre: 'Flota Norte', maxActivos: srv.maxActivos, activos: activos() });
    if (ruta === '/api/viajes/flota/choferes') {
      const p = new URLSearchParams(query);
      const limite = Number(p.get('limite'));
      const desde = Number(p.get('desde'));
      const pagina = srv.choferes.slice(desde, desde + limite);
      return json({ choferes: pagina, siguiente: desde + limite < srv.choferes.length ? desde + limite : null });
    }
    const id = ruta!.split('/').pop()!;
    const c = srv.choferes.find((x) => x.id === id);
    if (!c) return error(404, 'CHOFER_NO_ENCONTRADO');
    return json(srv.lecturaAtrasada ? (srv.anterior.get(id) ?? c) : c);
  }
  const clave = new Headers(init?.headers).get('idempotency-key') ?? '';
  (srv.claves[ruta!] ??= []).push(clave);
  let r = srv.guardadas.get(clave);
  if (!r) {
    r = aplicar(ruta!, init?.body ? JSON.parse(String(init.body)) : undefined);
    if (r.status < 500) srv.guardadas.set(clave, r);
  }
  if (srv.perderRespuesta) {
    srv.perderRespuesta = false;
    throw new TypeError('Failed to fetch');
  }
  return json(r.cuerpo, r.status);
}

let useFlota: typeof import('../src/roles/flota/store').useFlota;

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(servidorFalso));
  const { useSesion } = await import('../src/sesion/store');
  useSesion.setState({ estado: 'activa', token: 'access', refreshToken: 'refresh', epoca: 1 });
  ({ useFlota } = await import('../src/roles/flota/store'));
});

const choferSemilla = (n: number, cambios: Partial<Chofer> = {}): Chofer => ({
  id: idDe(n),
  flotaId: FLOTA,
  vehiculo: { patente: `AAA${String(n).padStart(3, '0')}`, marca: 'Fiat', modelo: 'Cronos' },
  habilitado: true,
  activo: false,
  disponible: false,
  ...cambios,
});

beforeEach(async () => {
  srv = {
    maxActivos: 2,
    choferes: [1, 2, 3].map((n) => choferSemilla(n)),
    guardadas: new Map(),
    claves: {},
    perderRespuesta: false,
    lecturaAtrasada: false,
    anterior: new Map(),
  };
  useFlota.getState().reiniciar();
  await useFlota.getState().refrescar();
});

/** Espera a que no quede ninguna operación ni alta en vuelo, y a que terminen las relecturas. */
async function esperarQuieto() {
  await vi.waitFor(() => {
    const s = useFlota.getState();
    const enVuelo = (f?: string) => f === 'enviando' || f === 'verificando';
    expect(Object.values(s.operaciones).some((o) => enVuelo(o.fase)) || enVuelo(s.alta?.fase)).toBe(false);
  });
  await new Promise((r) => setTimeout(r, 20));
}

const fila = (n: number) => useFlota.getState().choferes.find((c) => c.id === idDe(n))!;
const rutaActivar = (n: number) => `/api/viajes/flota/choferes/${idDe(n)}/activar`;

describe('activar con la respuesta perdida', () => {
  it('el servidor activa pero la respuesta no llega: la relectura del chofer lo confirma y la operación se cierra', async () => {
    srv.perderRespuesta = true;
    useFlota.getState().cambiarActivo(idDe(1), 'activar');
    await esperarQuieto();
    expect(srv.claves[rutaActivar(1)]).toHaveLength(1);
    expect(fila(1).activo).toBe(true);
    expect(useFlota.getState().operaciones[idDe(1)]).toBeUndefined();
    expect(useFlota.getState().flota?.activos).toBe(1);
  });

  it('si la relectura todavía no lo muestra, queda incierta y el reintento usa la MISMA clave: un solo cupo', async () => {
    srv.perderRespuesta = true;
    srv.lecturaAtrasada = true;
    useFlota.getState().cambiarActivo(idDe(1), 'activar');
    await esperarQuieto();
    expect(useFlota.getState().operaciones[idDe(1)]?.fase).toBe('incierta');

    srv.lecturaAtrasada = false;
    useFlota.getState().reintentar(idDe(1));
    await esperarQuieto();
    const [primera, segunda] = srv.claves[rutaActivar(1)]!;
    expect(segunda).toBe(primera);
    expect(fila(1).activo).toBe(true);
    expect(useFlota.getState().operaciones[idDe(1)]).toBeUndefined();
    expect(useFlota.getState().flota?.activos).toBe(1);
  });
});

describe('el límite y la liberación del cupo', () => {
  it('con la flota llena, activar da el mensaje del límite; desactivar a uno libera el cupo', async () => {
    const { cambiarActivo } = useFlota.getState();
    cambiarActivo(idDe(1), 'activar');
    cambiarActivo(idDe(2), 'activar');
    await esperarQuieto();
    expect(useFlota.getState().flota).toMatchObject({ activos: 2, maxActivos: 2 });

    cambiarActivo(idDe(3), 'activar');
    await esperarQuieto();
    const op = useFlota.getState().operaciones[idDe(3)];
    expect(op).toMatchObject({ fase: 'error', error: { codigo: 'LIMITE_FLOTA_ALCANZADO' } });
    expect(fila(3).activo).toBe(false);

    cambiarActivo(idDe(1), 'desactivar');
    await esperarQuieto();
    expect(useFlota.getState().flota?.activos).toBe(1);
    // Otro intento es otra operación: clave nueva, y ahora entra.
    cambiarActivo(idDe(3), 'activar');
    await esperarQuieto();
    expect(fila(3).activo).toBe(true);
    expect(new Set(srv.claves[rutaActivar(3)]).size).toBe(2);
    expect(useFlota.getState().flota?.activos).toBe(2);
  });
});

describe('alta con la respuesta perdida', () => {
  const datos = (n: number, modelo = 'Cronos'): DatosAlta => ({ choferId: idDe(n), vehiculo: { patente: `BBB${String(n).padStart(3, '0')}`, marca: 'Fiat', modelo } });

  it('el GET con 200 y el mismo vehículo confirma el alta', async () => {
    srv.perderRespuesta = true;
    useFlota.getState().darDeAlta(datos(9));
    await esperarQuieto();
    expect(useFlota.getState().alta?.fase).toBe('listo');
    expect(fila(9).vehiculo.patente).toBe('BBB009');
  });

  it('si el chofer ya estaba con otro vehículo, se muestra el real y no se da por hecha', async () => {
    srv.choferes.push({ ...choferSemilla(9), vehiculo: { patente: 'CCC009', marca: 'Ford', modelo: 'Ka' } });
    srv.perderRespuesta = true;
    useFlota.getState().darDeAlta(datos(9));
    await esperarQuieto();
    const alta = useFlota.getState().alta;
    expect(alta?.fase).toBe('difiere');
    expect(alta?.real?.vehiculo.patente).toBe('CCC009');
  });

  it('con 404 sigue incierta, y el reintento usa la MISMA clave', async () => {
    // La primera vez el pedido no llega al servidor (pero ya salió con su clave).
    let primera = '';
    vi.mocked(fetch).mockImplementationOnce(async (_url, init) => {
      primera = new Headers(init?.headers).get('idempotency-key') ?? '';
      throw new TypeError('Failed to fetch');
    });
    useFlota.getState().darDeAlta(datos(9));
    await esperarQuieto();
    expect(useFlota.getState().alta?.fase).toBe('incierta');

    useFlota.getState().reintentarAlta();
    await esperarQuieto();
    expect(useFlota.getState().alta?.fase).toBe('listo');
    expect(primera).not.toBe('');
    expect(srv.claves['/api/viajes/flota/choferes']).toEqual([primera]);
    expect(srv.choferes.filter((c) => c.id === idDe(9))).toHaveLength(1);
  });
});

describe('paginación con { choferes, siguiente }', () => {
  it('«Ver más» trae la página siguiente y «Actualizar» conserva las filas cargadas', async () => {
    srv.choferes = Array.from({ length: 12 }, (_, i) => choferSemilla(i + 1));
    useFlota.getState().reiniciar();
    await useFlota.getState().refrescar();
    expect(useFlota.getState().choferes).toHaveLength(10);
    expect(useFlota.getState().siguiente).toBe(10);

    await useFlota.getState().cargarMas();
    expect(useFlota.getState().choferes.map((c) => c.id)).toEqual(srv.choferes.map((c) => c.id));
    expect(useFlota.getState().siguiente).toBeNull();

    await useFlota.getState().refrescar();
    expect(useFlota.getState().choferes).toHaveLength(12);
  });
});

describe('errores de lectura', () => {
  it('un cupo que no se pudo leer (dispatch caído) deja el error; la próxima lectura buena lo borra', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => new Response('', { status: 502 }));
    await useFlota.getState().releerCupo();
    expect(useFlota.getState().errorCupo).toMatchObject({ estado: 502 });
    await useFlota.getState().releerCupo();
    expect(useFlota.getState().errorCupo).toBeNull();
    expect(useFlota.getState().errorLista).toBeNull();
  });
});
