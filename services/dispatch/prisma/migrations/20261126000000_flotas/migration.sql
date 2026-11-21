-- Flotas (variante G, docs/flotas.md). PR 1: flotas, choferes con vehículo, habilitación,
-- disponibilidad y el límite de choferes activos por flota. Las zonas van en el PR siguiente.

-- El id es el mismo `fleetId` que identity pone en el token del admin_flota.
CREATE TABLE "fleets" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "max_active" INTEGER NOT NULL,
    -- Cuántos choferes de la flota están activos. Lo mueven activar y desactivar, en la misma
    -- transacción que el cambio del chofer, con un UPDATE condicional (la carrera G).
    "active_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fleets_name_check" CHECK (length("name") BETWEEN 1 AND 80),
    CONSTRAINT "fleets_max_active_check" CHECK ("max_active" BETWEEN 0 AND 10000),
    -- La red de seguridad de la carrera G: aunque un error de programación saltee el UPDATE
    -- condicional, la base no deja que el contador pase el límite ni baje de cero.
    CONSTRAINT "fleets_cupo_check" CHECK ("active_count" >= 0 AND "active_count" <= "max_active")
);

-- El id es el `sub` del chofer en identity (sin FK: la cuenta vive en otra base). Un chofer está en
-- una sola flota. El vehículo va en la misma fila: un chofer, un vehículo.
CREATE TABLE "drivers" (
    "id" UUID NOT NULL,
    "fleet_id" UUID NOT NULL,
    "vehicle_plate" TEXT NOT NULL,
    "vehicle_make" TEXT NOT NULL,
    "vehicle_model" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "available" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "drivers_fleet_id_fkey" FOREIGN KEY ("fleet_id") REFERENCES "fleets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Las reglas del dominio, también en la base: activo exige habilitado; disponible exige activo.
    CONSTRAINT "drivers_activo_habilitado_check" CHECK (NOT "active" OR "approved"),
    CONSTRAINT "drivers_disponible_activo_check" CHECK (NOT "available" OR "active"),
    CONSTRAINT "drivers_vehicle_plate_check" CHECK ("vehicle_plate" ~ '^([A-Z]{3}[0-9]{3}|[A-Z]{2}[0-9]{3}[A-Z]{2})$')
);

CREATE UNIQUE INDEX "drivers_vehicle_plate_key" ON "drivers"("vehicle_plate");

-- Listado de la flota y, en el PR siguiente, el filtro de candidatos por flota.
CREATE INDEX "drivers_fleet_id_idx" ON "drivers"("fleet_id");
