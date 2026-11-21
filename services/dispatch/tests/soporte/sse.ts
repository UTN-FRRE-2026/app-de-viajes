import { request, type IncomingMessage } from 'node:http';

export interface EventoRecibido {
  id: string | undefined;
  tipo: string;
  data: Record<string, unknown>;
}

export interface StreamDePrueba {
  estado: number;
  encabezados: IncomingMessage['headers'];
  /** El cuerpo, si la respuesta no fue un stream (un error JSON). */
  cuerpo: () => string;
  eventos: EventoRecibido[];
  /** Comentarios recibidos (los latidos). */
  comentarios: string[];
  /** Espera hasta que haya un evento que cumpla `condicion`, o falla a los `ms`. */
  esperar(condicion: (e: EventoRecibido) => boolean, ms?: number): Promise<EventoRecibido>;
  /** Espera a que el servidor cierre la conexión. */
  cerrado: Promise<void>;
  cerrar(): void;
}

/**
 * Cliente SSE mínimo para los tests, como el que usaría el frontend con `fetch`: manda el
 * `Authorization` y el `Last-Event-ID` como encabezados y parsea `id:`, `event:` y `data:`.
 */
export function abrirStream(url: string, encabezados: Record<string, string>): Promise<StreamDePrueba> {
  return new Promise((resolver, rechazar) => {
    const pedido = request(url, { headers: { Accept: 'text/event-stream', ...encabezados } }, (res) => {
      const eventos: EventoRecibido[] = [];
      const comentarios: string[] = [];
      const esperas: Array<{ condicion: (e: EventoRecibido) => boolean; listo: (e: EventoRecibido) => void }> = [];
      let texto = '';
      let pendiente = '';
      res.setEncoding('utf8');

      const procesar = (bloque: string) => {
        let id: string | undefined;
        let tipo = 'message';
        const datos: string[] = [];
        for (const linea of bloque.split('\n')) {
          if (linea.startsWith(':')) comentarios.push(linea.slice(1).trim());
          else if (linea.startsWith('id: ')) id = linea.slice(4);
          else if (linea.startsWith('event: ')) tipo = linea.slice(7);
          else if (linea.startsWith('data: ')) datos.push(linea.slice(6));
        }
        if (datos.length === 0) return;
        const evento = { id, tipo, data: JSON.parse(datos.join('\n')) as Record<string, unknown> };
        eventos.push(evento);
        for (const espera of [...esperas]) {
          if (espera.condicion(evento)) {
            esperas.splice(esperas.indexOf(espera), 1);
            espera.listo(evento);
          }
        }
      };

      res.on('data', (parte: string) => {
        texto += parte;
        pendiente += parte;
        let corte: number;
        while ((corte = pendiente.indexOf('\n\n')) >= 0) {
          procesar(pendiente.slice(0, corte));
          pendiente = pendiente.slice(corte + 2);
        }
      });
      const cerrado = new Promise<void>((r) => res.on('close', () => r()));

      resolver({
        estado: res.statusCode ?? 0,
        encabezados: res.headers,
        cuerpo: () => texto,
        eventos,
        comentarios,
        cerrado,
        esperar(condicion, ms = 3000) {
          const ya = eventos.find(condicion);
          if (ya) return Promise.resolve(ya);
          return new Promise((listo, fallar) => {
            const timer = setTimeout(() => {
              fallar(new Error(`no llegó el evento esperado en ${ms} ms; llegaron: ${eventos.map((e) => e.tipo).join(', ')}`));
            }, ms);
            esperas.push({ condicion, listo: (e) => (clearTimeout(timer), listo(e)) });
          });
        },
        cerrar: () => pedido.destroy(),
      });
    });
    pedido.on('error', rechazar);
    pedido.end();
  });
}

export const deTipo = (tipo: string) => (e: EventoRecibido) => e.tipo === tipo;
