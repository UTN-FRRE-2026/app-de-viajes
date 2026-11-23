import { useEffect, useRef, useState } from 'react';
import { renovarAcceso } from '../api/cliente';
import type { ErrorApi } from '../api/errores';
import { useSesion } from '../sesion/store';
import { conectarEventos, esperar, type DependenciasEventos, type EstadoConexion } from './eventos';

const dependencias: DependenciasEventos = {
  fetch: (...args) => fetch(...args),
  token: () => useSesion.getState().token,
  renovar: renovarAcceso,
  epoca: () => useSesion.getState().epoca,
  esperar,
  azar: Math.random,
};

export interface Manejadores {
  alEvento(tipo: string, datos: unknown): void;
  alConectar?(): void;
}

/**
 * Los eventos del usuario (`GET /eventos`) mientras el componente está montado y hay sesión: un solo
 * stream por pantalla (dispatch permite 3 por usuario). Los manejadores pueden cambiar en cada render
 * sin reconectar. Devuelve el estado de la conexión, para mostrarlo.
 */
export function useEventos(manejadores: Manejadores): { estado: EstadoConexion; error: ErrorApi | null } {
  const ref = useRef(manejadores);
  ref.current = manejadores;
  const activa = useSesion((s) => s.estado === 'activa');
  const epoca = useSesion((s) => s.epoca);
  const [conexion, setConexion] = useState<{ estado: EstadoConexion; error: ErrorApi | null }>({ estado: 'conectando', error: null });

  useEffect(() => {
    if (!activa) return;
    return conectarEventos(
      {
        alEvento: (tipo, datos) => ref.current.alEvento(tipo, datos),
        alConectar: () => ref.current.alConectar?.(),
        alEstado: (estado, error) => setConexion({ estado, error }),
      },
      dependencias,
    );
  }, [activa, epoca]);

  return conexion;
}
