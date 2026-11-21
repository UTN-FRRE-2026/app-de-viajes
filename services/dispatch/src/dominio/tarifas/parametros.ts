/**
 * Parámetros de una tarifa. Todos los importes van en **centavos enteros** (nunca coma flotante) y
 * las distancias en metros enteros. Los valores los define el equipo; hoy salen del `.env` y, más
 * adelante, de la configuración del admin (PR 2), por eso llevan `version`.
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

/** Topes que dejan todos los cálculos holgadamente dentro de los enteros seguros de JavaScript. */
export const TOPE_IMPORTE_CENTAVOS = 100_000_000; // $1.000.000
export const TOPE_MAX_METROS = 1_000_000; // 1000 km

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
