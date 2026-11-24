-- Reporte de viajes y facturación por flota (docs/flotas.md#el-reporte-de-la-flota).
-- La consulta filtra por la flota guardada al aceptar, el estado y un período sobre started_at:
-- con este índice lee solo los viajes de esa flota en ese rango. Los viajes sin flota (fleet_id NULL,
-- de antes de 20261127000000_zonas) no entran nunca en el reporte.
CREATE INDEX "ride_requests_fleet_id_status_started_at_idx" ON "ride_requests"("fleet_id", "status", "started_at");
