-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "pings" (
    "id" BIGSERIAL NOT NULL,
    "driver_id" UUID NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pings_driver_id_recorded_at_idx" ON "pings"("driver_id", "recorded_at" DESC);


-- ---------------------------------------------------------------------------
-- Agregado a mano (Prisma no sabe expresar CHECK).
-- ---------------------------------------------------------------------------

-- Coordenadas válidas: red de seguridad por si algún camino de código no valida.
ALTER TABLE "pings" ADD CONSTRAINT "pings_lat_check" CHECK ("lat" BETWEEN -90 AND 90);
ALTER TABLE "pings" ADD CONSTRAINT "pings_lng_check" CHECK ("lng" BETWEEN -180 AND 180);
