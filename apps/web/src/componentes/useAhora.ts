import { useEffect, useState } from 'react';

/** La hora actual, actualizada cada `cadaMs`: para cuentas regresivas y «hace N s». */
export function useAhora(cadaMs = 1000): number {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), cadaMs);
    return () => clearInterval(t);
  }, [cadaMs]);
  return ahora;
}

/** «hace 4 s», «hace 2 min». */
export function hace(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `hace ${s} s` : `hace ${Math.round(s / 60)} min`;
}
