-- CreateTable
CREATE TABLE "refresh_tokens" (
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("token_hash")
);

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Agregado a mano (Prisma no sabe expresar CHECK).
-- ---------------------------------------------------------------------------

-- Un token sin vida, o usado antes de existir, solo puede venir de un error de código.
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_vigencia_check"
  CHECK ("expires_at" > "created_at" AND ("used_at" IS NULL OR "used_at" >= "created_at"));
