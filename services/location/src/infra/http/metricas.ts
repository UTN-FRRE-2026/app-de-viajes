import { Counter, Gauge, type Metricas } from '@viajes/platform';
import type { QuienPublica, ResultadoPublicacion } from '../../dominio/puertos/index.js';
import type { EstadoHistorial } from '../redis/historial.js';

const RESULTADOS_PUBLICACION: readonly ResultadoPublicacion[] = ['publicada', 'atrasada', 'vencida', 'error'];

/**
 * Métricas propias de location, en el mismo Registry que las comunes de `platform` (lag, memoria,
 * duración HTTP). La espera del historial en `carga/medir.ps1` depende de `location_historial_en_cola`
 * y `location_historial_pendientes`: si se renombran, hay que cambiar también ese script.
 */
export function registrarMetricasLocation(
  { registro }: Metricas,
  estrategia: string,
  historial?: () => Promise<EstadoHistorial>,
): void {
  new Gauge({
    name: 'location_estrategia',
    help: 'Estrategia de 6.6 con la que corre el proceso (siempre 1).',
    labelNames: ['estrategia'] as const,
    registers: [registro],
    collect() {
      this.set({ estrategia }, 1);
    },
  });
  if (!historial) return;

  // Una sola consulta a Redis por scrape: @prometheus-io/client llama a los cinco collect() juntos, antes de
  // esperar a ninguno, así que comparten la misma promesa. Al resolverse, el próximo scrape consulta de nuevo.
  let enCurso: Promise<EstadoHistorial> | undefined;
  const estado = () =>
    (enCurso ??= historial().finally(() => {
      enCurso = undefined;
    }));

  const series: Array<[string, string, (e: EstadoHistorial) => number]> = [
    ['location_historial_en_cola', 'Pings en el stream del historial, todavía sin escribir en Postgres.', (e) => e.enCola],
    ['location_historial_pendientes', 'Pings leídos por el consumidor y todavía sin confirmar.', (e) => e.pendientes],
    ['location_historial_descartados_total', 'Pings descartados del historial por cola llena.', (e) => e.descartados],
    ['location_historial_ocupacion', 'Ocupación de la cola del historial (0 a 1).', (e) => e.ocupacion],
    ['location_historial_max_cola', 'Tope de la cola del historial.', (e) => e.maxCola],
  ];
  for (const [name, help, valor] of series) {
    new Gauge({
      name,
      help,
      registers: [registro],
      async collect() {
        this.set(valor(await estado()));
      },
    });
  }
}

/**
 * `location_posiciones_publicadas_total{de, resultado}`: qué pasó con la publicación en vivo de cada
 * posición, del chofer o del pasajero (`de`), por resultado (`publicada`, `atrasada`, `vencida` o
 * `error`). Todas las series arrancan en 0 para que se vean en el primer scrape. Devuelve la función que cuenta.
 */
export function registrarMetricaPublicacion({ registro }: Metricas): (resultado: ResultadoPublicacion, de: QuienPublica) => void {
  const contador = new Counter({
    name: 'location_posiciones_publicadas_total',
    help: 'Publicaciones de la posición en vivo, por quién la informa y por resultado.',
    labelNames: ['de', 'resultado'] as const,
    registers: [registro],
  });
  for (const de of ['chofer', 'pasajero'] as const) {
    for (const resultado of RESULTADOS_PUBLICACION) contador.inc({ de, resultado }, 0);
  }
  return (resultado, de) => contador.inc({ de, resultado });
}
