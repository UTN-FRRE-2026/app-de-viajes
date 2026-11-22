# Contenedor web: nginx sin root (escucha en 8080). Se construye desde la raíz del repo:
#   docker build -f infra/web/Dockerfile .
# Por ahora sirve una página provisoria (infra/web/sitio). Cuando esté el frontend (apps/web), se suma
# una etapa que lo compila con Vite y se copia su dist/ en lugar de sitio/.
FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY infra/web/default.conf /etc/nginx/conf.d/default.conf
COPY infra/web/sitio/ /usr/share/nginx/html/

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/salud || exit 1
