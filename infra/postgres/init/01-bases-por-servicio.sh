#!/bin/bash
# Una base y un usuario por servicio. Cada usuario es dueño solo de su base y se le
# quita el acceso público a las demás: ningún servicio puede leer la BD de otro.
# Contraseña: DB_PASSWORD_<SERVICIO> si está definida; si no, "<servicio>_dev" (solo desarrollo).
set -euo pipefail

servicios="identity passengers drivers location dispatch trips payments notifications reservations"

crear_base() {
  local base="$1" usuario="$2"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE DATABASE ${base} OWNER ${usuario};
REVOKE ALL ON DATABASE ${base} FROM PUBLIC;
SQL
}

for s in $servicios; do
  var="DB_PASSWORD_${s^^}"
  clave="${!var:-${s}_dev}"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -c "CREATE ROLE ${s}_svc LOGIN PASSWORD '${clave}';"
  crear_base "$s" "${s}_svc"
done

# Base para los tests de integración y concurrencia de dispatch.
crear_base dispatch_test dispatch_svc
