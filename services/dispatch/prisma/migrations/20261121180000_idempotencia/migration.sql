-- Idempotency-Key (PLAN 3.5). Una fila por clave y usuario, escrita en la misma transacción que el efecto.
-- `response` es json y no jsonb: se devuelve tal cual se guardó, con las claves en el mismo orden.
CREATE TABLE "idempotency_keys" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status_code" SMALLINT NOT NULL,
    "response" JSON NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("scope", "key")
);

-- Para borrar los registros viejos.
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");
