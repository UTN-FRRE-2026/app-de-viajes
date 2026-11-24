import { randomUUID } from 'node:crypto';
import { TIPO_POSICION_CHOFER, TIPO_POSICION_PASAJERO } from '@viajes/contracts';
import { ErrorHttp, usuarioDe, type Logger } from '@viajes/platform';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ViajeConChofer, ViajeConPasajero } from '../../dominio/puertos/index.js';
import type { CupoConexiones } from './cupo-conexiones.js';
import { EVENTOS_DEL_SEGUIDO, Seguimiento, type ViajeSeguido } from './seguimiento.js';
import type { BusEventos, EventoEntregable, FuentePosiciones, HistorialEventos, Seguido } from './tipos.js';

/** `Last-Event-ID`: el `seq` del último evento que recibió el cliente. Un número, nada más. */
const UltimoId = z.string().regex(/^\d{1,15}$/, 'tiene que ser el id numérico del último evento recibido');

/**
 * Qué posición en vivo lleva el stream de cada rol: a quién sigue, con qué evento SSE (el mismo `tipo`
 * del contrato de location) y en qué campo va su id. Los demás roles no siguen a nadie.
 */
const POSICION_POR_ROL: Partial<Record<string, { de: Seguido; evento: string; campo: 'choferId' | 'pasajeroId' }>> = {
  pasajero: { de: 'chofer', evento: TIPO_POSICION_CHOFER, campo: 'choferId' },
  chofer: { de: 'pasajero', evento: TIPO_POSICION_PASAJERO, campo: 'pasajeroId' },
};

export interface OpcionesStreams {
  bus: BusEventos;
  historial: HistorialEventos;
  logger: Logger;
  /** Streams abiertos a la vez por usuario. Más, 429: cada stream ocupa memoria y una suscripción. */
  maxPorUsuario?: number;
  /**
   * El mismo límite contado entre todas las instancias (Redis). Sin esto, se cuenta solo en este
   * proceso: con N instancias, un usuario podría abrir N × maxPorUsuario.
   */
  cupo?: CupoConexiones;
  /** Cada cuánto se manda un comentario para que los proxies no corten la conexión por inactividad. */
  latidoMs?: number;
  /** Cuántos eventos perdidos se reponen como mucho al reconectar. El resto, por GET /solicitudes/:id. */
  maxReposicion?: number;
  /** Cuántos `seq` enviados recuerda cada stream para descartar repetidos. */
  memoriaRepetidos?: number;
  /**
   * La posición del chofer en el stream del pasajero, y la del pasajero en el del chofer. Sin esto, el
   * stream lleva solo los eventos.
   */
  posiciones?: {
    fuente: FuentePosiciones;
    viajeConChofer: (pasajeroId: string) => Promise<ViajeConChofer | null>;
    viajeConPasajero: (choferId: string) => Promise<ViajeConPasajero | null>;
  };
}

/**
 * `GET /eventos`: los eventos de los viajes del usuario del token, por Server-Sent Events.
 *
 * - **Solo lo propio:** se suscribe al canal del usuario, y el relay publica cada evento solo en el
 *   canal de su pasajero y de su chofer. No hay parámetro para pedir el de otro.
 * - **Reconexión con `Last-Event-ID`:** primero se suscribe (y guarda lo que llega), después repone
 *   del outbox lo que tiene `seq` mayor, y recién ahí manda lo guardado. Así no hay hueco entre la
 *   reposición y lo nuevo.
 * - **Sin repetidos:** el relay entrega al menos una vez, así que un evento puede llegar dos veces, o
 *   llegar por la reposición y también en vivo. Cada stream descarta los `seq` que ya mandó y los que
 *   no superan el `Last-Event-ID`.
 * - **Token vencido:** el stream se cierra cuando vence; el cliente se reconecta con uno nuevo.
 * - **Posición en vivo:** el stream de un pasajero lleva también la posición del chofer de su viaje
 *   activo, y el de un chofer la del pasajero de su viaje activo; la de nadie más (`Seguimiento`).
 *
 * El cliente usa `fetch` con el encabezado `Authorization` (EventSource no permite encabezados, y el
 * token no va en la URL porque quedaría en los logs). Al reconectar, pide además el estado actual con
 * GET /solicitudes/:id: el stream avisa de los cambios, la fuente de verdad sigue siendo la base.
 */
export class StreamsEventos {
  private readonly abiertos = new Map<string, Set<() => void>>();
  private readonly o: Required<Omit<OpcionesStreams, 'posiciones' | 'cupo'>> & Pick<OpcionesStreams, 'posiciones' | 'cupo'>;

  constructor(opciones: OpcionesStreams) {
    this.o = { maxPorUsuario: 3, latidoMs: 15_000, maxReposicion: 500, memoriaRepetidos: 1000, ...opciones };
  }

  /** Streams abiertos en este proceso. */
  get cantidad(): number {
    let n = 0;
    for (const s of this.abiertos.values()) n += s.size;
    return n;
  }

  /** Al apagar: corta todos los streams para que el servidor no espere al timeout. */
  cerrarTodos(): void {
    for (const streams of this.abiertos.values()) for (const cerrar of [...streams]) cerrar();
  }

  manejador(): RequestHandler {
    return async (req, res) => {
      const usuario = usuarioDe(req);
      const encabezado = req.header('last-event-id');
      let ultimo = 0;
      if (encabezado !== undefined) {
        const leido = UltimoId.safeParse(encabezado);
        if (!leido.success) throw new ErrorHttp(400, 'LAST_EVENT_ID_INVALIDO', `Last-Event-ID: ${leido.error.issues[0]?.message}`);
        ultimo = Number(leido.data);
      }

      // El cupo se reserva antes de cualquier await: dos pedidos simultáneos no pueden pasarse del límite.
      let propios = this.abiertos.get(usuario.id);
      if (!propios) this.abiertos.set(usuario.id, (propios = new Set()));
      if (propios.size >= this.o.maxPorUsuario) {
        throw new ErrorHttp(429, 'DEMASIADAS_CONEXIONES', `Como mucho ${this.o.maxPorUsuario} conexiones de eventos a la vez`);
      }

      let cerrado = false;
      // El lugar en el cupo compartido (si hay): vence a los tres latidos sin renovar.
      const cupo = this.o.cupo;
      const idConexion = randomUUID();
      const ttlCupoMs = this.o.latidoMs * 3;
      let enCupo = false;
      const soltarCupo = () => {
        if (!cupo || !enCupo) return;
        enCupo = false;
        void cupo.soltar(usuario.id, idConexion).catch(() => {});
      };
      const timers: { latido?: NodeJS.Timeout; vencimiento?: NodeJS.Timeout } = {};
      let desuscribir: (() => Promise<void>) | undefined;
      const seguimiento: { actual?: Seguimiento } = {};
      /** Suelta el cupo, los timers y las suscripciones. No toca la respuesta. */
      const liberar = () => {
        if (cerrado) return;
        cerrado = true;
        clearInterval(timers.latido);
        clearTimeout(timers.vencimiento);
        propios.delete(cerrar);
        if (propios.size === 0) this.abiertos.delete(usuario.id);
        soltarCupo();
        void desuscribir?.().catch(() => {});
        seguimiento.actual?.terminar();
      };
      const cerrar = () => {
        liberar();
        if (!res.writableEnded) res.end();
      };
      propios.add(cerrar);
      // El `close` de la respuesta, no el del pedido: en un GET, el pedido "cierra" apenas se terminó de leer.
      res.on('close', cerrar);

      // El cupo entre instancias, después del local (que ya reservó sin await). Falla abierto: si Redis no
      // responde, queda el límite de este proceso y el stream sigue; sin Redis tampoco llegarían eventos.
      if (cupo) {
        let resultado: 'tomado' | 'lleno' | 'sin_cupo';
        try {
          resultado = (await cupo.tomar(usuario.id, idConexion, this.o.maxPorUsuario, ttlCupoMs)) ? 'tomado' : 'lleno';
        } catch (err) {
          this.o.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'eventos: cupo compartido no disponible, cuenta solo esta instancia');
          resultado = 'sin_cupo';
        }
        if (resultado === 'tomado') {
          enCupo = true;
          // El cliente se fue mientras se tomaba: se suelta ya, no al vencer.
          if (cerrado) soltarCupo();
        }
        if (cerrado) return;
        if (resultado === 'lleno') {
          // liberar y no cerrar: la respuesta todavía no salió y tiene que ser el 429.
          liberar();
          throw new ErrorHttp(429, 'DEMASIADAS_CONEXIONES', `Como mucho ${this.o.maxPorUsuario} conexiones de eventos a la vez`);
        }
      }

      const enviados = new Set<number>();
      const enviar = (e: EventoEntregable) => {
        if (cerrado || e.seq <= ultimo || enviados.has(e.seq)) return;
        enviados.add(e.seq);
        if (enviados.size > this.o.memoriaRepetidos) enviados.delete(enviados.values().next().value as number);
        res.write(`id: ${e.seq}\nevent: ${e.tipo}\ndata: ${JSON.stringify(e.payload)}\n\n`);
        // Pudo cambiar a quién seguir: se vuelve a leer de la base.
        if (EVENTOS_DEL_SEGUIDO.has(e.tipo)) void seguimiento.actual?.sincronizar();
      };

      // 1. Suscribirse primero, guardando lo que llegue mientras se repone.
      let reponiendo = true;
      const enEspera: EventoEntregable[] = [];
      try {
        desuscribir = await this.o.bus.suscribir(usuario.id, (e) => (reponiendo ? enEspera.push(e) : enviar(e)));
      } catch (err) {
        // liberar y no cerrar: la respuesta todavía no salió y tiene que ser el 503 de abajo.
        liberar();
        this.o.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'eventos: no se pudo suscribir');
        throw new ErrorHttp(503, 'EVENTOS_NO_DISPONIBLE', 'No se pueden recibir eventos en este momento');
      }
      if (cerrado) return; // el cliente se fue mientras tanto

      res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // nginx: que no junte la respuesta en su buffer, o los eventos llegarían tarde.
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      res.write('retry: 3000\n\n');

      // La posición de la otra parte del viaje, recién con los encabezados enviados. Sin `id:`, para
      // que no se repongan ni muevan el Last-Event-ID del cliente.
      const posicion = POSICION_POR_ROL[usuario.rol];
      if (this.o.posiciones && posicion) {
        const { fuente, viajeConChofer, viajeConPasajero } = this.o.posiciones;
        const viajeActivo = async (id: string): Promise<ViajeSeguido | null> => {
          if (posicion.de === 'chofer') {
            const v = await viajeConChofer(id);
            return v && { solicitudId: v.solicitudId, id: v.choferId };
          }
          const v = await viajeConPasajero(id);
          return v && { solicitudId: v.solicitudId, id: v.pasajeroId };
        };
        seguimiento.actual = new Seguimiento(usuario.id, { posiciones: fuente, de: posicion.de, viajeActivo, logger: this.o.logger }, (viaje, p) => {
          if (cerrado) return;
          const datos = { solicitudId: viaje.solicitudId, [posicion.campo]: p.id, lat: p.lat, lng: p.lng, actualizadaEn: p.actualizadaEn };
          res.write(`event: ${posicion.evento}\ndata: ${JSON.stringify(datos)}\n\n`);
        });
        void seguimiento.actual.sincronizar();
      }

      // 2. Reponer lo perdido, y 3. lo que llegó mientras tanto, en orden.
      try {
        if (encabezado !== undefined) {
          for (const e of await this.o.historial.desde(usuario.id, ultimo, this.o.maxReposicion)) enviar(e);
        }
      } catch (err) {
        // Los encabezados ya salieron: no hay respuesta de error posible. Se corta y el cliente reintenta.
        this.o.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'eventos: falló la reposición');
        cerrar();
        return;
      }
      reponiendo = false;
      for (const e of enEspera.sort((a, b) => a.seq - b.seq)) enviar(e);

      timers.latido = setInterval(() => {
        res.write(': latido\n\n');
        if (cupo && enCupo) void cupo.renovar(usuario.id, idConexion, ttlCupoMs).catch(() => {});
      }, this.o.latidoMs);
      if (usuario.venceEn) {
        timers.vencimiento = setTimeout(cerrar, Math.max(0, usuario.venceEn.getTime() - Date.now()));
      }
    };
  }
}
