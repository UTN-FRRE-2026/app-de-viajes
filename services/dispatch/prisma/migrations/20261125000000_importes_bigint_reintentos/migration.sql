-- Dos correcciones a la migración 20261123000000 (tarifa final y cobro).

-- 1. Importes en BIGINT. Con INTEGER, el máximo es 2 147 483 647 centavos (unos $21 millones). Una
--    tarifa que el admin puede configurar lo pasa: 100 000 000 centavos por km (el tope, $1 000 000) en un viaje de
--    30 km ya son 3 000 000 000. La solicitud fallaba al insertarse, y una tarifa final que no entrara
--    deshacía la finalización y dejaba al chofer asignado. `calcularTarifa` nunca devuelve más que
--    Number.MAX_SAFE_INTEGER, que entra de sobra en BIGINT. Distancias y duraciones siguen en INTEGER:
--    68 años en segundos o 2 millones de km.
ALTER TABLE "ride_requests"
    ALTER COLUMN "estimated_fare_cents" TYPE BIGINT,
    ALTER COLUMN "final_fare_cents" TYPE BIGINT;

ALTER TABLE "payments" ALTER COLUMN "amount_cents" TYPE BIGINT;

-- 2. El barrido elige los cobros pendientes por el último intento, no por la creación. Cada fallo
--    actualiza updated_at y manda el cobro al final de la cola. Ordenando por created_at, si los 20
--    más viejos fallaban siempre, se elegían en cada barrido y los más nuevos no se intentaban nunca.
DROP INDEX "payments_status_created_at_idx";
CREATE INDEX "payments_status_updated_at_idx" ON "payments"("status", "updated_at");
