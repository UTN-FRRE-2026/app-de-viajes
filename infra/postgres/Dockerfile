# Postgres con PostGIS y el script que crea una base y un usuario por servicio, adentro de la imagen.
# Lo usa docker-compose.coolify.yml: Coolify no monta archivos del repo como volumen (crea una carpeta
# vacía), así que el bind mount de infra/postgres/init del docker-compose.yml no serviría ahí.
# El script corre solo con el volumen vacío (la primera vez).
FROM postgis/postgis:16-3.4
COPY --chmod=755 infra/postgres/init/ /docker-entrypoint-initdb.d/
