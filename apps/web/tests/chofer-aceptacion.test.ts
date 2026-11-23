import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EstadoChoferRespuesta, OfertaPendiente, Solicitud } from '../src/viaje/viaje';

/**
 * La aceptación con la respuesta perdida, con el store real y un servidor falso detrás de `fetch`: el
 * servidor acepta y registra la clave, pero la respuesta no llega al navegador.
 */

class Almacen {
  private datos = new Map<string, string>();
  getItem = (k: string) => this.datos.get(k) ?? null;
  setItem = (k: string, v: string) => void this.datos.set(k, v);
  removeItem = (k: string) => void this.datos.delete(k);
}

const S1 = '11111111-1111-4111-8111-111111111111';
const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const oferta: OfertaPendiente = {
  ofertaId: O1,
  solicitudId: S1,
  venceEn: new Date(Date.now() + 10_000).toISOString(),
  origen: { lat: -34.6, lng: -58.38 },
  destino: { lat: -34.58, lng: -58.42 },
  tarifaEstimadaCentavos: 150_000,
};
const asignada: Solicitud = {
  id: S1,
  pasajeroId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  origen: oferta.origen,
  destino: oferta.destino,
  estado: 'ASIGNADO',
  choferId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  motivoCancelacion: null,
  tarifa: null,
  version: 1,
};

/** El servidor: acepta la primera vez y, con la misma clave, repite la respuesta (como la idempotencia real). */
interface Servidor {
  aceptada: boolean;
  /** Las claves de cada POST de aceptar que llegó. */
  claves: string[];
  /** La respuesta del próximo POST se pierde (el servidor sí lo procesa). */
  perderRespuesta: boolean;
  /** `GET /chofer/estado` todavía no muestra el viaje (por ejemplo, una réplica atrasada). */
  estadoAtrasado: boolean;
}
let srv: Servidor;

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } });

async function servidorFalso(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const ruta = String(url);
  if (ruta === '/api/viajes/chofer/estado') {
    const viaje = srv.aceptada && !srv.estadoAtrasado ? asignada : null;
    const r: EstadoChoferRespuesta = { ahora: new Date().toISOString(), registro: null, viaje, ofertas: [] };
    return json(r);
  }
  if (ruta === `/api/viajes/ofertas/${O1}/aceptar`) {
    const clave = new Headers(init?.headers).get('idempotency-key') ?? '';
    srv.claves.push(clave);
    if (srv.aceptada && clave !== srv.claves[0]) return json({ error: { code: 'SOLICITUD_NO_DISPONIBLE', message: 'no' } }, 409);
    srv.aceptada = true;
    if (srv.perderRespuesta) {
      srv.perderRespuesta = false;
      throw new TypeError('Failed to fetch');
    }
    return json(asignada);
  }
  throw new Error(`ruta inesperada: ${ruta}`);
}

let useChofer: typeof import('../src/roles/chofer/store').useChofer;

beforeAll(async () => {
  vi.stubGlobal('sessionStorage', new Almacen());
  vi.stubGlobal('fetch', vi.fn(servidorFalso));
  const { useSesion } = await import('../src/sesion/store');
  useSesion.setState({ estado: 'activa', token: 'access', refreshToken: 'refresh', epoca: 1 });
  ({ useChofer } = await import('../src/roles/chofer/store'));
});

beforeEach(() => {
  srv = { aceptada: false, claves: [], perderRespuesta: true, estadoAtrasado: false };
  useChofer.getState().reiniciar();
});

/** Espera a que el store quede quieto (sin aceptación enviándose ni lecturas en vuelo). */
async function esperarQuieto() {
  await vi.waitFor(() => {
    expect(useChofer.getState().aceptacion?.fase).not.toBe('enviando');
  });
  await new Promise((r) => setTimeout(r, 20));
}

describe('aceptar con la respuesta perdida', () => {
  it('el servidor acepta pero la respuesta no llega: la relectura muestra el viaje y la operación se cierra', async () => {
    useChofer.getState().aceptar(oferta);
    await esperarQuieto();
    const s = useChofer.getState();
    expect(srv.claves).toHaveLength(1);
    expect(s.viaje?.id).toBe(S1);
    expect(s.aceptacion).toBeNull();
  });

  it('si la relectura todavía no lo muestra, queda incierta con su clave y el reintento usa la MISMA', async () => {
    srv.estadoAtrasado = true;
    useChofer.getState().aceptar(oferta);
    await esperarQuieto();
    const incierta = useChofer.getState().aceptacion;
    expect(incierta).toMatchObject({ fase: 'incierta', oferta: { ofertaId: O1 } });
    expect(useChofer.getState().viaje).toBeNull();

    // Ahora la base ya está al día; el reintento con la misma clave repite la respuesta de la primera vez.
    srv.estadoAtrasado = false;
    useChofer.getState().reintentarAceptacion();
    await esperarQuieto();
    expect(srv.claves).toEqual([incierta!.clave, incierta!.clave]);
    expect(useChofer.getState().viaje?.id).toBe(S1);
    expect(useChofer.getState().aceptacion).toBeNull();
  });
});
