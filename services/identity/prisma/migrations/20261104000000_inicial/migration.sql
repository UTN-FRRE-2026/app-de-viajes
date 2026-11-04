-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "fleet_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");


-- ---------------------------------------------------------------------------
-- Agregado a mano (Prisma no sabe expresar CHECK).
-- ---------------------------------------------------------------------------

-- Roles válidos: los mismos que espera packages/platform/src/autenticacion.ts.
ALTER TABLE "users" ADD CONSTRAINT "users_role_check"
  CHECK ("role" IN ('pasajero', 'chofer', 'operador', 'admin', 'admin_flota'));

-- admin_flota siempre tiene flota, y ningún otro rol la tiene.
ALTER TABLE "users" ADD CONSTRAINT "users_fleet_id_check"
  CHECK (("role" = 'admin_flota') = ("fleet_id" IS NOT NULL));

-- El email se guarda normalizado: sin esto, la unicidad distinguiría mayúsculas.
ALTER TABLE "users" ADD CONSTRAINT "users_email_minusculas_check"
  CHECK ("email" = lower("email"));
