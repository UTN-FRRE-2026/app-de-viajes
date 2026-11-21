-- Ciclo de vida completo del viaje (plan, sección 3.1): EN_CAMINO, EN_CURSO, CANCELADO_CHOFER
-- y CANCELADO_OPERADOR, más el motivo de la cancelación.

ALTER TABLE "ride_requests" ADD COLUMN "cancel_reason" TEXT;

-- Estados válidos.
ALTER TABLE "ride_requests" DROP CONSTRAINT "ride_requests_status_check";
ALTER TABLE "ride_requests" ADD CONSTRAINT "ride_requests_status_check"
  CHECK ("status" IN ('BUSCANDO', 'ASIGNADO', 'EN_CAMINO', 'EN_CURSO', 'COMPLETADA',
                      'CANCELADO_PASAJERO', 'CANCELADO_CHOFER', 'CANCELADO_OPERADOR', 'SIN_CHOFERES'));

-- Todo estado al que solo se llega con un chofer asignado tiene chofer.
ALTER TABLE "ride_requests" DROP CONSTRAINT "ride_requests_asignado_con_chofer_check";
ALTER TABLE "ride_requests" ADD CONSTRAINT "ride_requests_con_chofer_check"
  CHECK ("status" NOT IN ('ASIGNADO', 'EN_CAMINO', 'EN_CURSO', 'COMPLETADA', 'CANCELADO_CHOFER')
         OR "driver_id" IS NOT NULL);

-- La cancelación del operador siempre lleva motivo.
ALTER TABLE "ride_requests" ADD CONSTRAINT "ride_requests_cancelado_operador_con_motivo_check"
  CHECK ("status" <> 'CANCELADO_OPERADOR' OR "cancel_reason" IS NOT NULL);

-- Un pasajero tiene como máximo un viaje activo: ahora también cuentan EN_CAMINO y EN_CURSO.
DROP INDEX "ride_requests_una_activa_por_pasajero";
CREATE UNIQUE INDEX "ride_requests_una_activa_por_pasajero"
  ON "ride_requests"("passenger_id")
  WHERE "status" IN ('BUSCANDO', 'ASIGNADO', 'EN_CAMINO', 'EN_CURSO');
