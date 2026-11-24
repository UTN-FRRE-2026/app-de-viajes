# Contenedor web: nginx sin root (escucha en 8080) con el frontend (apps/web) ya compilado.
# Se construye desde la raíz del repo:
#   docker build -f infra/web/Dockerfile .

# 1. El frontend: React + Vite. `npm run build` también revisa que el resultado cumpla la CSP de la
#    página (sin scripts ni estilos en línea).
FROM node:22-alpine AS frontend
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm ci --workspace @viajes/web \
 && npm run build -w @viajes/web

# 2. nginx: la configuración y el build.
FROM nginxinc/nginx-unprivileged:1.27-alpine

# Como plantilla: al arrancar, la imagen de nginx reemplaza ${CADDY_IP} y escribe conf.d/default.conf.
# Solo esa variable (NGINX_ENVSUBST_FILTER): las $variables de nginx quedan como están.
ENV CADDY_IP=10.250.77.11 \
    NGINX_ENVSUBST_FILTER=^CADDY_IP$
COPY infra/web/default.conf /etc/nginx/templates/default.conf.template
COPY --from=frontend /repo/apps/web/dist/ /usr/share/nginx/html/

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/salud || exit 1
