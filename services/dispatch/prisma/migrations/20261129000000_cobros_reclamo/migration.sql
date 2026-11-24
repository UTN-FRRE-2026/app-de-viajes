-- Reclamo de los cobros pendientes por el barrido (ADR 0012). Con más de una instancia de dispatch,
-- dos barridos podían elegir el mismo cobro y llamar dos veces al proveedor. Ahora el barrido lo
-- reclama con FOR UPDATE SKIP LOCKED y le pone un vencimiento: otro barrido no lo toma hasta que se
-- suelte (al fallar) o venza (si la instancia murió a mitad de camino).
ALTER TABLE payments ADD COLUMN claimed_until timestamptz(3);
