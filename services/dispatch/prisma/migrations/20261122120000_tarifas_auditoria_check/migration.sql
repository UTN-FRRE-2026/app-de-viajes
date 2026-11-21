-- Corrige el CHECK de la auditoría de tarifas (20261122000000_tarifas). Va en una migración aparte
-- porque la original ya se aplicó.
--
-- El CHECK anterior era `(version = 1 AND previous_version IS NULL) OR (previous_version = version - 1)`.
-- Con `previous_version` NULL y `version` > 1, la segunda parte da NULL (no false), y un CHECK que da
-- NULL se considera cumplido: aceptaba una versión 5 sin anterior. Ahora cada rama pide los nulos o
-- no nulos de forma explícita, y también los valores anteriores (sin ellos el cambio no se explica).
ALTER TABLE "fare_changes" DROP CONSTRAINT "fare_changes_cadena_check";

ALTER TABLE "fare_changes" ADD CONSTRAINT "fare_changes_cadena_check" CHECK (
    ("version" = 1 AND "previous_version" IS NULL AND "previous_values" IS NULL)
    OR (
        "version" > 1
        AND "previous_version" IS NOT NULL
        AND "previous_version" = "version" - 1
        AND "previous_values" IS NOT NULL
    )
);
