#!/bin/sh
# Arranque de los servicios (Dockerfile de la raíz). Con MIGRAR_AL_ARRANCAR=si, primero aplica las
# migraciones de Prisma de este servicio (prisma.config.ts lee su *_DATABASE_URL); si fallan, el
# contenedor termina con error y no arranca con un esquema viejo. Es lo que usa Coolify
# (docker-compose.coolify.yml): ahí no hay una máquina desde donde correr `npm run migrate:deploy`.
# `migrate deploy` es idempotente: sin migraciones nuevas no hace nada.
set -eu

if [ "${MIGRAR_AL_ARRANCAR:-no}" = "si" ]; then
  /app/node_modules/.bin/prisma migrate deploy
fi

# exec: node queda como PID 1 y recibe el SIGTERM directo (apagado ordenado, platform/apagado.ts).
exec node dist/servidor.js
