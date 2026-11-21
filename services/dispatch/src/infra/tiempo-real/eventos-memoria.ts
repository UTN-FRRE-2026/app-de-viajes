import type { RepositorioDespachoMemoria } from '../memoria/repositorio-memoria.js';
import { destinatariosDe, type BusEventos, type EventoEntregable, type HistorialEventos, type RelayEventos } from './tipos.js';

/**
 * Lo mismo que el outbox de Postgres, sobre la lista de eventos del repositorio en memoria: la
 * posición en la lista hace de `seq`. Para correr sin Postgres ni Redis.
 */
export class EventosMemoria implements HistorialEventos {
  private publicados = 0;

  constructor(
    private readonly repo: RepositorioDespachoMemoria,
    private readonly bus: BusEventos,
  ) {}

  private entregable(i: number): EventoEntregable {
    const e = this.repo.eventos[i]!;
    const payload = e.payload as Record<string, unknown>;
    return { seq: i + 1, tipo: e.tipo, payload, destinatarios: destinatariosDe(payload) };
  }

  readonly relay: RelayEventos = async () => {
    const hasta = this.repo.eventos.length;
    for (let i = this.publicados; i < hasta; i++) await this.bus.publicar(this.entregable(i));
    const n = hasta - this.publicados;
    this.publicados = hasta;
    return n;
  };

  async desde(usuarioId: string, desde: number, limite: number): Promise<EventoEntregable[]> {
    const resultado: EventoEntregable[] = [];
    for (let i = desde; i < this.repo.eventos.length && resultado.length < limite; i++) {
      const e = this.entregable(i);
      if (e.destinatarios.includes(usuarioId)) resultado.push(e);
    }
    return resultado;
  }
}
