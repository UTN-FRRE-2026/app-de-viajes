-- Historial del chofer (el del pasajero ya usa ride_requests_passenger_id_idx).
CREATE INDEX "ride_requests_driver_id_idx" ON "ride_requests"("driver_id");

-- Panel del operador: filtra por estado y ordena por fecha.
CREATE INDEX "ride_requests_status_created_at_idx" ON "ride_requests"("status", "created_at");
