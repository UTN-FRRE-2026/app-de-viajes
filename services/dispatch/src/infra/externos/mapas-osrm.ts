import type { Coordenada } from '../../dominio/entidades/index.js';
import type { Recorrido } from '../../dominio/tarifas/calculo.js';
import type { Ruta, ServicioMapas, ServicioRutas } from '../../dominio/puertos/index.js';

export interface OpcionesMapasOsrm {
  /** La base del servidor OSRM, sin la barra final (por ejemplo, https://router.project-osrm.org). */
  url: string;
  /** Cada pedido a OSRM se cancela pasado este tiempo (AbortSignal): no queda colgado. */
  timeoutMs: number;
  /** Cuántas rutas recordar. Las consultas se repiten (el mapa, la estimación, el mismo viaje). */
  maxCache?: number;
  /** Se reemplaza en los tests. */
  fetch?: typeof fetch;
  /** Cada lectura: del caché o de OSRM. Para las métricas. */
  alResolver?: (resultado: 'cache' | 'calles') => void;
}

interface CuerpoOsrm {
  code?: unknown;
  routes?: { distance?: unknown; duration?: unknown; geometry?: { coordinates?: unknown } }[];
}

const esNoNegativo = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const esPar = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);

/**
 * Ruteo real por las calles con OSRM (OpenStreetMap), el mismo que usa el chofer automático de la demo
 * (`scripts/simular-chofer.mjs`): así el auto avanza sobre la ruta que muestra el mapa.
 *
 * Lanza si OSRM no responde a tiempo, contesta un error o algo fuera de forma. Quién decide qué hacer
 * con eso es `MapasConRespaldo` (la línea recta), no este adaptador.
 *
 * Caché en memoria (LRU) por coordenadas redondeadas a 5 decimales (~1 m): el servidor público pide no
 * más de un pedido por segundo, y la estimación y el mapa piden la misma ruta. Los pedidos en curso
 * también se comparten: si el mapa y la estimación piden la misma ruta a la vez (antes de que llegue la
 * primera respuesta), sale un solo pedido a OSRM y los dos esperan esa respuesta.
 */
export class MapasOsrm implements ServicioMapas, ServicioRutas {
  private readonly cache = new Map<string, Ruta>();
  /** Los pedidos a OSRM que todavía no contestaron, por clave. Se borran al terminar, bien o mal. */
  private readonly enCurso = new Map<string, Promise<Ruta>>();

  constructor(private readonly opciones: OpcionesMapasOsrm) {}

  async recorrido(origen: Coordenada, destino: Coordenada): Promise<Recorrido> {
    const { metros, segundos } = await this.ruta(origen, destino);
    return { metros, segundos };
  }

  async ruta(origen: Coordenada, destino: Coordenada): Promise<Ruta> {
    const clave = [origen.lat, origen.lng, destino.lat, destino.lng].map((n) => n.toFixed(5)).join(',');
    const guardada = this.cache.get(clave);
    if (guardada) {
      // LRU: la que se usa pasa al final, y se descarta la del principio.
      this.cache.delete(clave);
      this.cache.set(clave, guardada);
      this.opciones.alResolver?.('cache');
      return guardada;
    }
    const compartido = this.enCurso.get(clave);
    if (compartido) {
      // Ya hay un pedido en vuelo para esta ruta: se espera ese, no se manda otro. Si falla, falla para
      // todos los que lo esperaban (y cada uno recibe el respaldo de MapasConRespaldo).
      const ruta = await compartido;
      this.opciones.alResolver?.('cache');
      return ruta;
    }
    const pedido = this.pedir(origen, destino)
      .then((ruta) => {
        this.cache.set(clave, ruta);
        const maximo = this.opciones.maxCache ?? 500;
        while (this.cache.size > maximo) this.cache.delete(this.cache.keys().next().value as string);
        return ruta;
      })
      .finally(() => this.enCurso.delete(clave));
    this.enCurso.set(clave, pedido);
    const ruta = await pedido;
    this.opciones.alResolver?.('calles');
    return ruta;
  }

  private async pedir(origen: Coordenada, destino: Coordenada): Promise<Ruta> {
    const url =
      `${this.opciones.url}/route/v1/driving/${origen.lng},${origen.lat};${destino.lng},${destino.lat}` +
      '?overview=full&geometries=geojson';
    const respuesta = await (this.opciones.fetch ?? fetch)(url, {
      signal: AbortSignal.timeout(this.opciones.timeoutMs),
      // La política del servidor público pide identificarse. Sin datos del usuario.
      headers: { accept: 'application/json', 'user-agent': 'app-viajes/0.1 (proyecto academico)' },
    });
    if (!respuesta.ok) throw new Error(`OSRM respondió ${respuesta.status}`);
    const cuerpo = (await respuesta.json()) as CuerpoOsrm;
    const primera = cuerpo.routes?.[0];
    if (cuerpo.code !== 'Ok' || !primera) throw new Error(`OSRM sin ruta (${String(cuerpo.code)})`);
    const coordenadas = primera.geometry?.coordinates;
    if (!esNoNegativo(primera.distance) || !esNoNegativo(primera.duration) || !Array.isArray(coordenadas)) {
      throw new Error('OSRM: respuesta fuera de forma');
    }
    const pares = coordenadas.filter(esPar);
    if (pares.length < 2 || pares.length !== coordenadas.length) throw new Error('OSRM: geometría fuera de forma');
    return {
      metros: Math.round(primera.distance),
      segundos: Math.round(primera.duration),
      // GeoJSON es [lng, lat]; el resto del sistema usa lat primero.
      puntos: pares.map(([lng, lat]) => [lat, lng]),
      fuente: 'calles',
    };
  }
}
