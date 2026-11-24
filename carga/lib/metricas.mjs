// Lectura de /metrics (formato de Prometheus) y cuantiles por ventana: la diferencia entre dos fotos de
// un histograma acumulado da la distribución de esa ventana. Lo usan solicitudes.js, estres y resumir.

export async function leerMetricas(base, token) {
  const res = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`/metrics de ${base} respondió ${res.status}`);
  return res.text();
}

/** Valor de una serie: la primera línea `nombre{...}` cuyas etiquetas contienen todos los `filtros`. */
export function serie(texto, nombre, ...filtros) {
  for (const linea of texto.split('\n')) {
    if (!linea.startsWith(nombre)) continue;
    const resto = linea.slice(nombre.length);
    if (resto[0] !== '{' && resto[0] !== ' ') continue;
    if (filtros.some((f) => !resto.includes(f))) continue;
    return Number(linea.trim().split(/\s+/).pop());
  }
  return null;
}

/** Suma de una serie en todas las líneas que contienen los filtros (por ejemplo, todos los estados). */
export function sumaSerie(texto, nombre, ...filtros) {
  let total = 0;
  for (const linea of texto.split('\n')) {
    if (!linea.startsWith(nombre)) continue;
    const resto = linea.slice(nombre.length);
    if (resto[0] !== '{' && resto[0] !== ' ') continue;
    if (filtros.some((f) => !resto.includes(f))) continue;
    total += Number(linea.trim().split(/\s+/).pop());
  }
  return total;
}

/**
 * Cubetas acumuladas de un histograma, sumadas sobre las líneas que contienen los filtros (por ejemplo,
 * todas las respuestas de una ruta, de cualquier estado): [{ le, cuenta }] ordenadas.
 */
export function cubetas(texto, nombre, ...filtros) {
  const por = new Map();
  for (const linea of texto.split('\n')) {
    if (!linea.startsWith(`${nombre}_bucket{`)) continue;
    if (filtros.some((f) => !linea.includes(f))) continue;
    const le = linea.match(/le="([^"]+)"/)?.[1];
    const clave = le === '+Inf' ? Infinity : Number(le);
    por.set(clave, (por.get(clave) ?? 0) + Number(linea.trim().split(/\s+/).pop()));
  }
  return [...por].map(([le, cuenta]) => ({ le, cuenta })).sort((a, b) => a.le - b.le);
}

/**
 * La ventana entre dos fotos de un histograma: cuántas observaciones y sus cuantiles por cubeta (el
 * borde superior de la cubeta donde cae el cuantil; Infinity si cae por encima de la última).
 */
export function ventanaHistograma(antes, despues, nombre, ...filtros) {
  const a = new Map(cubetas(antes, nombre, ...filtros).map((c) => [c.le, c.cuenta]));
  const dif = cubetas(despues, nombre, ...filtros).map((c) => ({ le: c.le, cuenta: c.cuenta - (a.get(c.le) ?? 0) }));
  const total = dif.at(-1)?.cuenta ?? 0;
  const q = (x) => (total === 0 ? null : (dif.find((c) => c.cuenta >= x * total)?.le ?? null));
  const fmt = (v) => (v === Infinity ? '+Inf' : v);
  return { cuenta: total, p50: fmt(q(0.5)), p95: fmt(q(0.95)), p99: fmt(q(0.99)) };
}

/** Percentil exacto de una lista de valores (método del rango más cercano). */
export function percentil(valores, q) {
  if (valores.length === 0) return null;
  const ordenados = [...valores].sort((x, y) => x - y);
  return Math.round(ordenados[Math.min(ordenados.length - 1, Math.ceil(q * ordenados.length) - 1)]);
}

export const percentiles = (valores) => ({
  n: valores.length,
  p50: percentil(valores, 0.5),
  p95: percentil(valores, 0.95),
  p99: percentil(valores, 0.99),
  max: valores.length ? Math.round(Math.max(...valores)) : null,
});

/** RSS de un servicio en una foto de /metrics, en MB. */
export function memoriaMb(texto) {
  const v = serie(texto, 'process_resident_memory_bytes');
  return v === null ? null : Math.round(v / 1048576);
}
