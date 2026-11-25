# Imagen genérica para cualquier servicio: docker build --build-arg SERVICE=dispatch .
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS build
ARG SERVICE
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY services/${SERVICE} ./services/${SERVICE}
RUN npm ci --workspace "@viajes/${SERVICE}" --include-workspace-root \
 && npm run build -w @viajes/kernel -w @viajes/contracts -w @viajes/platform \
 && npm run build -w "@viajes/${SERVICE}"

# Los usuarios de prueba (seed de identity), como un contenedor que corre una vez y termina. Lo usa el
# entorno de Coolify (docker-compose.coolify.yml, con target: semilla y SERVICE=identity): ahí no hay
# una máquina desde donde correr `npm run seed`. Necesita tsx y el código fuente: por eso sale de build.
FROM build AS semilla
ENV NODE_ENV=development
USER node
CMD ["npm", "run", "seed", "--silent", "-w", "@viajes/identity"]

FROM build AS podado
ARG SERVICE
RUN npm prune --omit=dev --workspace "@viajes/${SERVICE}" --include-workspace-root

# La imagen del servicio. Tiene que ser la última etapa: es la que se construye sin --target.
FROM node:${NODE_VERSION}-alpine
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app
COPY --from=podado --chown=node:node /repo/node_modules ./node_modules
COPY --from=podado --chown=node:node /repo/packages ./packages
COPY --from=podado --chown=node:node /repo/services/${SERVICE}/package.json ./services/${SERVICE}/package.json
COPY --from=podado --chown=node:node /repo/services/${SERVICE}/dist ./services/${SERVICE}/dist
COPY --from=podado --chown=node:node /repo/services/${SERVICE}/prisma ./services/${SERVICE}/prisma
# Para `prisma migrate deploy` dentro del contenedor (MIGRAR_AL_ARRANCAR, infra/servicio/arrancar.sh).
COPY --from=podado --chown=node:node /repo/services/${SERVICE}/prisma.config.ts ./services/${SERVICE}/prisma.config.ts
COPY --chmod=755 infra/servicio/arrancar.sh /usr/local/bin/arrancar
WORKDIR /app/services/${SERVICE}
USER node
ENV PUERTO=3000
# start-period largo: con MIGRAR_AL_ARRANCAR=si, las migraciones corren antes de que el servidor escuche.
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PUERTO+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["arrancar"]
