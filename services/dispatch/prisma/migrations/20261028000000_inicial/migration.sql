-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "ride_requests" (
    "id" UUID NOT NULL,
    "passenger_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "origin_lat" DOUBLE PRECISION NOT NULL,
    "origin_lng" DOUBLE PRECISION NOT NULL,
    "destination_lat" DOUBLE PRECISION NOT NULL,
    "destination_lng" DOUBLE PRECISION NOT NULL,
    "driver_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ride_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_active_assignment" (
    "driver_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_active_assignment_pkey" PRIMARY KEY ("driver_id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ride_requests_passenger_id_idx" ON "ride_requests"("passenger_id");

-- CreateIndex
CREATE INDEX "offers_status_expires_at_idx" ON "offers"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "offers_request_id_driver_id_key" ON "offers"("request_id", "driver_id");

-- CreateIndex
CREATE UNIQUE INDEX "driver_active_assignment_request_id_key" ON "driver_active_assignment"("request_id");

-- CreateIndex
CREATE INDEX "outbox_published_at_created_at_idx" ON "outbox"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "ride_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_active_assignment" ADD CONSTRAINT "driver_active_assignment_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "ride_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Agregado a mano (Prisma no sabe expresar CHECK ni índices parciales).
-- ---------------------------------------------------------------------------

-- Estados válidos: red de seguridad por si algún camino de código escribe un estado inventado.
ALTER TABLE "ride_requests" ADD CONSTRAINT "ride_requests_status_check"
  CHECK ("status" IN ('BUSCANDO', 'ASIGNADO', 'CANCELADO_PASAJERO', 'SIN_CHOFERES', 'COMPLETADA'));

-- Una solicitud ASIGNADO siempre tiene chofer; las demás que no lo tuvieron, no.
ALTER TABLE "ride_requests" ADD CONSTRAINT "ride_requests_asignado_con_chofer_check"
  CHECK ("status" <> 'ASIGNADO' OR "driver_id" IS NOT NULL);

ALTER TABLE "offers" ADD CONSTRAINT "offers_status_check"
  CHECK ("status" IN ('PENDIENTE', 'ACEPTADA', 'VENCIDA', 'CANCELADA'));

-- Un pasajero tiene como máximo una solicitud activa a la vez.
CREATE UNIQUE INDEX "ride_requests_una_activa_por_pasajero"
  ON "ride_requests"("passenger_id")
  WHERE "status" IN ('BUSCANDO', 'ASIGNADO');
