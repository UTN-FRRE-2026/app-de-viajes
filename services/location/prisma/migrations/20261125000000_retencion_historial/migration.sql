-- Retención del historial (docs/location.md#retención-del-historial). La purga elige los pings vencidos
-- por `recorded_at`, ordenados por (recorded_at, id), en lotes: este índice la acompaña, así cada lote
-- lee solo las filas que va a borrar, aunque una fila vieja haya entrado tarde (historial en lotes).
CREATE INDEX "pings_recorded_at_id_idx" ON "pings"("recorded_at", "id");
