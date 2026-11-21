/** Una flota con su cupo de choferes activos. `activos` es el contador que protege la carrera G. */
export interface Flota {
  id: string;
  nombre: string;
  maxActivos: number;
  activos: number;
}

/** Lo que el admin define de una flota. El contador no se edita: lo mueven activar y desactivar. */
export interface DatosFlota {
  id: string;
  nombre: string;
  maxActivos: number;
}
