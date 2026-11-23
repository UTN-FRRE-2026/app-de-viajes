import { canalPosicionChofer, canalPosicionPasajero, PosicionChoferPublicada, PosicionPasajeroPublicada } from '@viajes/contracts';
import type { Logger } from '@viajes/platform';
import type { Redis } from 'ioredis';
import type { FuentePosiciones, PosicionEnVivo, Seguido } from './tipos.js';

type Oyente = (posicion: PosicionEnVivo) => void;

/** El canal y el contrato de cada uno. `leer` devuelve null si el mensaje no es de ese contrato. */
const CANALES: Record<Seguido, { canal: (prefijo: string, id: string) => string; leer: (mensaje: unknown) => PosicionEnVivo | null }> = {
  chofer: {
    canal: canalPosicionChofer,
    leer: (m) => {
      const r = PosicionChoferPublicada.safeParse(m);
      return r.success ? { id: r.data.choferId, lat: r.data.lat, lng: r.data.lng, actualizadaEn: r.data.actualizadaEn } : null;
    },
  },
  pasajero: {
    canal: canalPosicionPasajero,
    leer: (m) => {
      const r = PosicionPasajeroPublicada.safeParse(m);
      return r.success ? { id: r.data.pasajeroId, lat: r.data.lat, lng: r.data.lng, actualizadaEn: r.data.actualizadaEn } : null;
    },
  },
};

/**
 * Las posiciones que publica location (docs/location.md, «Posición en vivo»):
 * `<LOCATION_REDIS_PREFIJO>posicion:<choferId>` y `<LOCATION_REDIS_PREFIJO>posicion-pasajero:<pasajeroId>`.
 *
 * - `SUBSCRIBE` al canal de cada persona seguida, no `PSUBSCRIBE` a todos: con un patrón, cada instancia
 *   de dispatch recibiría las posiciones de todos.
 * - Una sola suscripción por canal y por proceso, aunque lo sigan varios streams (dos pestañas): se
 *   suscribe con el primero y se da de baja con el último.
 * - Una conexión propia, para los dos tipos de canal: en modo suscriptor no acepta otros comandos.
 * - Valida cada mensaje con el contrato de su canal y que sea de la persona del canal. Lo demás se
 *   descarta: la posición de un chofer publicada en el canal de un pasajero no pasa, ni al revés.
 */
export class PosicionesRedis implements FuentePosiciones {
  private readonly suscriptor: Redis;
  /** canal → de quién es y oyentes */
  private readonly canales = new Map<string, { de: Seguido; id: string; oyentes: Set<Oyente>; listo: Promise<void> }>();

  constructor(
    redis: Redis,
    private readonly prefijo: string,
    private readonly logger: Logger,
  ) {
    // Sin timeout por comando: la conexión queda esperando mensajes a propósito.
    this.suscriptor = redis.duplicate({ commandTimeout: undefined });
    this.suscriptor.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis (posiciones): error de conexión'));
    this.suscriptor.on('message', (canal: string, texto: string) => this.recibir(canal, texto));
  }

  private recibir(canal: string, texto: string): void {
    const suscripto = this.canales.get(canal);
    if (!suscripto) return;
    let posicion: PosicionEnVivo | null;
    try {
      posicion = CANALES[suscripto.de].leer(JSON.parse(texto));
    } catch {
      posicion = null;
    }
    if (!posicion || posicion.id !== suscripto.id) {
      this.logger.warn({ canal }, 'posiciones: mensaje fuera de contrato, se descarta');
      return;
    }
    for (const oyente of suscripto.oyentes) oyente(posicion);
  }

  async suscribir(de: Seguido, id: string, alRecibir: Oyente) {
    const canal = CANALES[de].canal(this.prefijo, id);
    let suscripto = this.canales.get(canal);
    if (!suscripto) {
      const nuevo = { de, id, oyentes: new Set<Oyente>(), listo: this.suscriptor.subscribe(canal).then(() => {}) };
      // Si falla, que el próximo intento vuelva a suscribirse en vez de creer que ya lo está.
      nuevo.listo.catch(() => {
        if (this.canales.get(canal) === nuevo) this.canales.delete(canal);
      });
      this.canales.set(canal, nuevo);
      suscripto = nuevo;
    }
    suscripto.oyentes.add(alRecibir);
    try {
      // El segundo stream que sigue a la misma persona espera la misma suscripción.
      await suscripto.listo;
    } catch (err) {
      suscripto.oyentes.delete(alRecibir);
      throw err;
    }
    return async () => {
      const actual = this.canales.get(canal);
      if (!actual) return;
      actual.oyentes.delete(alRecibir);
      if (actual.oyentes.size === 0) {
        this.canales.delete(canal);
        await this.suscriptor.unsubscribe(canal).catch(() => {});
      }
    };
  }

  async cerrar(): Promise<void> {
    this.canales.clear();
    this.suscriptor.disconnect();
  }
}
