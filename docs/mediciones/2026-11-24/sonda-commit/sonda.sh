#!/bin/bash
# Uso: sonda.sh <iteraciones> <salida>. Un INSERT con commit (fsync del WAL) cada 200 ms en el Postgres de carga.
N=$1; OUT=$2
docker exec viajes-carga-postgres-1 psql -U carga -d location_carga -qc "CREATE DATABASE sonda" 2>/dev/null
docker exec viajes-carga-postgres-1 psql -U carga -d sonda -qc "CREATE TABLE IF NOT EXISTS s (t timestamptz)"
{ echo '\timing on'; for i in $(seq 1 $N); do echo "INSERT INTO s VALUES (clock_timestamp()) RETURNING to_char(clock_timestamp() at time zone 'UTC','HH24:MI:SS.MS');"; echo "SELECT pg_sleep(0.2);"; done; } \
 | docker exec -i viajes-carga-postgres-1 psql -U carga -d sonda -tA 2>&1 \
 | awk '/^[0-9][0-9]:[0-9][0-9]:/{t=$0; next} /^Time:/ && t!=""{print t, $2; t=""}' > "$OUT"
