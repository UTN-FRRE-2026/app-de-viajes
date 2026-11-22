import type { Rol } from '@viajes/contracts';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface Usuario {
  id: string;
  email: string;
  nombre: string;
  rol: Rol;
  fleetId?: string;
}

/** Lo que responden `POST /login` y `POST /refresh` de identity (docs/identity.md). */
export interface RespuestaSesion {
  token: string;
  tipo: 'Bearer';
  expiraEnSegundos: number;
  refreshToken: string;
  refreshExpiraEnSegundos: number;
  usuario: Usuario;
}

/**
 * - `cargando`: al abrir la página, mientras se recupera la sesión guardada (no se redirige todavía).
 * - `anonima`: sin sesión; las rutas protegidas llevan al login.
 * - `activa`: hay access token vigente.
 */
export type EstadoSesion = 'cargando' | 'anonima' | 'activa';

interface Sesion {
  estado: EstadoSesion;
  usuario: Usuario | null;
  /** El access token: solo en memoria, nunca en el almacenamiento del navegador. */
  token: string | null;
  /** Se guarda en sessionStorage (se pierde al cerrar la pestaña) para recuperar la sesión al recargar. */
  refreshToken: string | null;
  /**
   * Cambia cada vez que una sesión empieza o termina. Una renovación que vuelve con otra época llegó
   * tarde (por ejemplo, después de cerrar sesión) y se descarta.
   */
  epoca: number;
  /** Login: empieza una sesión nueva. */
  iniciar(r: RespuestaSesion): void;
  /** Refresh: la misma sesión, con tokens nuevos (identity rota el refresh en cada uso). */
  renovada(r: RespuestaSesion): void;
  /** Sin sesión: logout, refresh inválido o un 401 que no se pudo resolver. */
  cerrar(): void;
}

export const useSesion = create<Sesion>()(
  persist(
    (set) => ({
      estado: 'cargando',
      usuario: null,
      token: null,
      refreshToken: null,
      epoca: 0,
      iniciar: (r) =>
        set((s) => ({ estado: 'activa', usuario: r.usuario, token: r.token, refreshToken: r.refreshToken, epoca: s.epoca + 1 })),
      renovada: (r) => set({ estado: 'activa', usuario: r.usuario, token: r.token, refreshToken: r.refreshToken }),
      cerrar: () => set((s) => ({ estado: 'anonima', usuario: null, token: null, refreshToken: null, epoca: s.epoca + 1 })),
    }),
    {
      name: 'viajes:sesion',
      storage: createJSONStorage(() => sessionStorage),
      // Solo lo necesario para recuperar la sesión al recargar. Nunca el access token.
      partialize: (s) => ({ usuario: s.usuario, refreshToken: s.refreshToken }),
    },
  ),
);
