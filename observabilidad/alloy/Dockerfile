# Alloy con su configuración adentro, para docker-compose.coolify.yml: Coolify no tiene los archivos del repo
# en el servidor, así que no se puede montar config.alloy como en docker-compose.yml. Misma imagen y misma
# configuración que el perfil `obs` (docs/observabilidad.md).
FROM grafana/alloy:v1.21.3

COPY observabilidad/alloy/config.alloy /etc/alloy/config.alloy

# La interfaz y /-/ready escuchan solo dentro del contenedor (127.0.0.1:12345, el valor por defecto): el
# healthcheck las usa y nada de afuera las alcanza.
#
# Corre como root, igual que la imagen original: necesita leer el socket de Docker, que en el host es de
# root:docker con un GID que cambia de un servidor a otro. Un usuario sin privilegios no bajaría el riesgo:
# quien usa el socket maneja el daemon, y con él el host. Por eso Alloy no publica puertos (ver el compose).
# nosemgrep: dockerfile.security.missing-user.missing-user -- el acceso al socket de Docker ya equivale a root en el host; ver arriba.
CMD ["run", "/etc/alloy/config.alloy", "--storage.path=/var/lib/alloy/data"]
