-- Retención por viaje (docs/location.md#retención-del-historial): 30 días los pings de un viaje y 24 h
-- los demás. `en_viaje` es la marca de cada fila: NULL = sin clasificar (todas las filas nuevas y las
-- que ya estaban), TRUE = de un viaje, se conserva hasta la retención total. Los pings sin viaje no se
-- marcan: se borran. Agregar la columna sin DEFAULT no reescribe la tabla.
ALTER TABLE "pings" ADD COLUMN "en_viaje" BOOLEAN;

-- La clasificación elige los pings sin clasificar más viejos que 24 h, por (recorded_at, id). Índice
-- parcial: solo tiene los que faltan clasificar, así un ping escrito tarde con un recorded_at viejo se
-- encuentra igual, y los de viaje ya marcados no se vuelven a recorrer. Prisma no expresa el WHERE:
-- está solo acá.
CREATE INDEX "pings_sin_clasificar_idx" ON "pings"("recorded_at", "id") WHERE "en_viaje" IS NULL;
