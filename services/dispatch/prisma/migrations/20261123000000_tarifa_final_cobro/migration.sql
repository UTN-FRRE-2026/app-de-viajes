-- PR 3 de tarifas (docs/tarifas.md): estimación guardada al crear, tarifa final al finalizar y cobro.

-- La estimación con la que se pidió el viaje y la tarifa final, en centavos enteros. La versión es la
-- de fare_versions (como texto, `v3`); la final se calcula con la MISMA versión que la estimación.
-- Las solicitudes creadas antes de esta migración quedan sin tarifa (todo NULL).
ALTER TABLE "ride_requests"
    ADD COLUMN "fare_version" TEXT,
    ADD COLUMN "estimated_fare_cents" INTEGER,
    ADD COLUMN "estimated_distance_m" INTEGER,
    ADD COLUMN "estimated_duration_s" INTEGER,
    ADD COLUMN "final_fare_cents" INTEGER,
    ADD COLUMN "final_distance_m" INTEGER,
    ADD COLUMN "final_duration_s" INTEGER,
    -- Por qué el importe final difiere del estimado: DISTANCIA, DURACION. Vacío si son iguales.
    ADD COLUMN "fare_difference_reasons" TEXT[] NOT NULL DEFAULT '{}',
    -- Cuándo subió el pasajero: de acá se mide la duración real.
    ADD COLUMN "started_at" TIMESTAMPTZ(3);

ALTER TABLE "ride_requests"
    -- La estimación va completa o no va.
    ADD CONSTRAINT "ride_requests_estimacion_check" CHECK (
        ("fare_version" IS NULL AND "estimated_fare_cents" IS NULL AND "estimated_distance_m" IS NULL AND "estimated_duration_s" IS NULL)
        OR ("fare_version" IS NOT NULL AND "estimated_fare_cents" >= 0 AND "estimated_distance_m" >= 0 AND "estimated_duration_s" >= 0)
    ),
    -- La final va completa o no va, y solo en un viaje con estimación.
    ADD CONSTRAINT "ride_requests_tarifa_final_check" CHECK (
        ("final_fare_cents" IS NULL AND "final_distance_m" IS NULL AND "final_duration_s" IS NULL)
        OR ("fare_version" IS NOT NULL AND "final_fare_cents" >= 0 AND "final_distance_m" >= 0 AND "final_duration_s" >= 0)
    ),
    -- Un viaje con estimación no puede quedar COMPLETADA sin tarifa final, ni tenerla sin completarse.
    ADD CONSTRAINT "ride_requests_completada_con_tarifa_check" CHECK (
        "fare_version" IS NULL OR (("status" = 'COMPLETADA') = ("final_fare_cents" IS NOT NULL))
    ),
    ADD CONSTRAINT "ride_requests_motivos_check" CHECK (
        "fare_difference_reasons" <@ ARRAY['DISTANCIA', 'DURACION']::TEXT[]
    );

-- Un cobro por viaje completado, por la tarifa final. El id es también la clave de idempotencia con
-- el proveedor de pagos: reintentar con la misma nunca cobra dos veces.
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "passenger_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'ARS',
    "status" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "provider_ref" TEXT,
    "decline_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "ride_requests"("id"),
    CONSTRAINT "payments_amount_check" CHECK ("amount_cents" >= 0),
    CONSTRAINT "payments_currency_check" CHECK ("currency" = 'ARS'),
    CONSTRAINT "payments_status_check" CHECK ("status" IN ('PENDIENTE', 'APROBADO', 'RECHAZADO')),
    CONSTRAINT "payments_failed_attempts_check" CHECK ("failed_attempts" >= 0),
    -- Aprobado o rechazado, siempre con la referencia del proveedor; rechazado, con su motivo.
    CONSTRAINT "payments_resuelto_check" CHECK (
        ("status" = 'PENDIENTE' AND "provider_ref" IS NULL AND "decline_reason" IS NULL)
        OR ("status" = 'APROBADO' AND "provider_ref" IS NOT NULL AND "decline_reason" IS NULL)
        OR ("status" = 'RECHAZADO' AND "provider_ref" IS NOT NULL AND "decline_reason" IS NOT NULL)
    )
);

-- Un solo cobro por viaje: una segunda finalización no puede crear otro.
CREATE UNIQUE INDEX "payments_request_id_key" ON "payments"("request_id");

-- El barrido busca los pendientes, los más viejos primero.
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");
