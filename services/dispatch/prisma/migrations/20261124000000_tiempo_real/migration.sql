-- Tiempo real por SSE (PLAN 3.5). El relay lee el outbox y publica en Redis Pub/Sub.

-- `seq`: el id de cada evento en el stream SSE (`id:` y `Last-Event-ID`). Crece en el orden en que se
-- insertan los eventos. Dentro de un mismo viaje coincide con el orden de confirmación, porque todo lo
-- que cambia un viaje toma antes el lock de su fila.
ALTER TABLE "outbox" ADD COLUMN "seq" BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX "outbox_seq_key" ON "outbox"("seq");

-- A quién se le entrega el evento: el pasajero y el chofer que figuran en el payload. Nadie más.
ALTER TABLE "outbox" ADD COLUMN "recipients" UUID[] NOT NULL DEFAULT '{}';
UPDATE "outbox" SET "recipients" = array_remove(
    ARRAY[("payload"->>'pasajeroId')::uuid, ("payload"->>'choferId')::uuid], NULL
);

-- Reconexión: los eventos de un usuario después de un `seq`.
CREATE INDEX "outbox_recipients_idx" ON "outbox" USING GIN ("recipients");

-- El relay: los que faltan publicar, en orden.
CREATE INDEX "outbox_pendientes_idx" ON "outbox"("seq") WHERE "published_at" IS NULL;
