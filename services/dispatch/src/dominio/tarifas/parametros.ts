import { TOPE_IMPORTE_CENTAVOS, TOPE_MAX_METROS } from '@viajes/contracts';

export { TOPE_IMPORTE_CENTAVOS, TOPE_MAX_METROS };

/**
 * Parámetros de una tarifa. Todos los importes van en **centavos enteros** (nunca coma flotante) y
 * las distancias en metros enteros. Los configura el admin (versionados en Postgres); la primera
 * versión sale de los `TARIFA_*` del entorno. `version` identifica cada configuración (`v1`, `v2`...).
 */
export interface ParametrosTarifa {
  /** Identifica estos valores: la estimación la devuelve y la tarifa final la va a comparar. */
  version: string;
  moneda: 'ARS';
  bajadaCentavos: number;
  centavosPorKm: number;
  centavosPorMinuto: number;
  /** Ningún viaje cobra menos que esto. */
  minimoCentavos: number;
  /** Un recorrido más largo no se acepta. Justo en el máximo, sí. */
  maxMetros: number;
}

/** Lo que configura el admin: los cinco valores. Moneda y versión las pone el servidor. */
export type ValoresTarifa = Omit<ParametrosTarifa, 'version' | 'moneda'>;

/** Una versión guardada, con quién la configuró y cuándo. */
export interface TarifaVigente extends ParametrosTarifa {
  /** El id del admin (`sub` del token), o `semilla` para la versión inicial tomada del entorno. */
  actualizadaPor: string;
  actualizadaEn: Date;
}

export const AUTOR_SEMILLA = 'semilla';

const IMPORTES = ['bajadaCentavos', 'centavosPorKm', 'centavosPorMinuto', 'minimoCentavos'] as const;

/**
 * Comprueba los invariantes y devuelve la lista de problemas (vacía si están bien). Nombra el campo
 * y el límite, pero no repite el valor recibido.
 */
export function problemasDeParametros(p: ParametrosTarifa): string[] {
  const problemas: string[] = [];
  if (!p.version.trim()) problemas.push('version: no puede estar vacía');
  for (const campo of IMPORTES) {
    const v = p[campo];
    if (!Number.isInteger(v) || v < 0 || v > TOPE_IMPORTE_CENTAVOS) {
      problemas.push(`${campo}: tiene que ser un entero entre 0 y ${TOPE_IMPORTE_CENTAVOS}`);
    }
  }
  if (!Number.isInteger(p.maxMetros) || p.maxMetros < 1 || p.maxMetros > TOPE_MAX_METROS) {
    problemas.push(`maxMetros: tiene que ser un entero entre 1 y ${TOPE_MAX_METROS}`);
  }
  return problemas;
}
