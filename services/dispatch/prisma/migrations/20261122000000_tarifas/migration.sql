-- Tarifa global versionada (docs/tarifas.md, PR 2 de tarifas).
-- Las versiones no se modifican nunca: cada cambio del admin crea una nueva. La vigente se marca en
-- `fare_current` (una sola fila) y cada cambio deja su auditoría en `fare_changes`.

CREATE TABLE "fare_versions" (
    "version" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'ARS',
    "base_fare_cents" INTEGER NOT NULL,
    "per_km_cents" INTEGER NOT NULL,
    "per_minute_cents" INTEGER NOT NULL,
    "minimum_cents" INTEGER NOT NULL,
    "max_meters" INTEGER NOT NULL,
    -- El `sub` del admin que la configuró, o 'semilla' para la versión inicial tomada del entorno.
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fare_versions_pkey" PRIMARY KEY ("version"),
    -- Los mismos límites que el contrato y el dominio: la base no acepta una tarifa inválida aunque
    -- un error de programación la deje pasar.
    CONSTRAINT "fare_versions_version_check" CHECK ("version" >= 1),
    CONSTRAINT "fare_versions_currency_check" CHECK ("currency" = 'ARS'),
    CONSTRAINT "fare_versions_importes_check" CHECK (
        "base_fare_cents" BETWEEN 0 AND 100000000 AND
        "per_km_cents" BETWEEN 0 AND 100000000 AND
        "per_minute_cents" BETWEEN 0 AND 100000000 AND
        "minimum_cents" BETWEEN 0 AND 100000000
    ),
    CONSTRAINT "fare_versions_max_meters_check" CHECK ("max_meters" BETWEEN 1 AND 1000000)
);

-- Una sola fila: la versión vigente. Las ediciones la bloquean (FOR UPDATE) y así se serializan.
CREATE TABLE "fare_current" (
    "id" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fare_current_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fare_current_una_fila" CHECK ("id"),
    CONSTRAINT "fare_current_version_fkey" FOREIGN KEY ("version") REFERENCES "fare_versions"("version")
);

-- Auditoría: quién, cuándo, valores anteriores y nuevos. Una fila por versión.
CREATE TABLE "fare_changes" (
    "version" INTEGER NOT NULL,
    "previous_version" INTEGER,
    "changed_by" TEXT NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previous_values" JSONB,
    "new_values" JSONB NOT NULL,
    -- El requestId del pedido HTTP, para cruzarlo con el log.
    "request_id" TEXT,

    CONSTRAINT "fare_changes_pkey" PRIMARY KEY ("version"),
    CONSTRAINT "fare_changes_version_fkey" FOREIGN KEY ("version") REFERENCES "fare_versions"("version"),
    CONSTRAINT "fare_changes_previous_version_fkey" FOREIGN KEY ("previous_version") REFERENCES "fare_versions"("version"),
    -- El historial es una cadena: cada versión parte de la anterior (la 1, de ninguna).
    CONSTRAINT "fare_changes_cadena_check" CHECK (
        ("version" = 1 AND "previous_version" IS NULL) OR ("previous_version" = "version" - 1)
    )
);

-- Los mismos que declara schema.prisma (una versión tiene a lo sumo un cambio que la sigue).
CREATE UNIQUE INDEX "fare_current_version_key" ON "fare_current"("version");
CREATE UNIQUE INDEX "fare_changes_previous_version_key" ON "fare_changes"("previous_version");
