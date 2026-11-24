-- Zonas operativas (variante G, docs/flotas.md). PR 2 de flotas: polígonos en PostGIS, zonas
-- habilitadas por flota, la zona del origen de cada solicitud y la flota del chofer que la aceptó.

-- La extensión necesita superusuario si todavía no está instalada. En desarrollo la instala el init
-- de Postgres (infra/postgres/init) o `npm run setup`, porque dispatch_svc no es superusuario; con
-- IF NOT EXISTS, esta línea no hace nada si ya está. En CI y en carga el usuario es superusuario.
CREATE EXTENSION IF NOT EXISTS postgis;

-- Una zona es un polígono en lng/lat (SRID 4326). Dos zonas no se superponen: lo controla el caso de
-- uso bajo un advisory lock (un CHECK no puede mirar otras filas). Un punto en un borde compartido es
-- de la zona de menor id.
CREATE TABLE "zones" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "area" geometry(Polygon, 4326) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "zones_name_check" CHECK (length("name") BETWEEN 1 AND 80),
    CONSTRAINT "zones_area_valida_check" CHECK (ST_IsValid("area"))
);

-- Resolver la zona de un origen (ST_Covers) usa este índice.
CREATE INDEX "zones_area_idx" ON "zones" USING GIST ("area");

-- Las zonas donde opera cada flota. Quitar una fila (el admin le saca la zona) choca con el FOR SHARE
-- que toma la aceptación: una aceptación en curso termina antes, o ve la zona ya quitada.
CREATE TABLE "fleet_zones" (
    "fleet_id" UUID NOT NULL,
    "zone_id" UUID NOT NULL,

    CONSTRAINT "fleet_zones_pkey" PRIMARY KEY ("fleet_id", "zone_id"),
    CONSTRAINT "fleet_zones_fleet_id_fkey" FOREIGN KEY ("fleet_id") REFERENCES "fleets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "fleet_zones_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "fleet_zones_zone_id_idx" ON "fleet_zones"("zone_id");

-- La zona del origen (resuelta al crear) y la flota del chofer al aceptar. NULL en los viajes de antes
-- de esta migración: no se completan hacia atrás (no se sabe qué flota tenía el chofer entonces).
ALTER TABLE "ride_requests"
    ADD COLUMN "zone_id" UUID,
    ADD COLUMN "fleet_id" UUID,
    ADD CONSTRAINT "ride_requests_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "ride_requests_fleet_id_fkey" FOREIGN KEY ("fleet_id") REFERENCES "fleets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
