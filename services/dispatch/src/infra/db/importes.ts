/**
 * Un total de centavos que Postgres devuelve como `numeric` (`SUM(bigint)`), leído como texto para no
 * perder precisión en el camino. Se pasa a `number` solo si es un entero seguro: si no, falla en vez
 * de devolver un monto redondeado.
 */
export function totalCentavos(texto: string): number {
  if (!/^\d+$/.test(texto)) throw new RangeError(`total de centavos inválido: ${texto}`);
  const exacto = BigInt(texto);
  if (exacto > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`total de centavos fuera de rango: ${texto}`);
  return Number(exacto);
}
