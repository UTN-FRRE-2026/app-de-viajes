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
 && npm run build -w "@viajes/${SERVICE}" \
 && npm prune --omit=dev --workspace "@viajes/${SERVICE}" --include-workspace-root

FROM node:${NODE_VERSION}-alpine
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/packages ./packages
COPY --from=build --chown=node:node /repo/services/${SERVICE}/package.json ./services/${SERVICE}/package.json
COPY --from=build --chown=node:node /repo/services/${SERVICE}/dist ./services/${SERVICE}/dist
COPY --from=build --chown=node:node /repo/services/${SERVICE}/prisma ./services/${SERVICE}/prisma
WORKDIR /app/services/${SERVICE}
USER node
ENV PUERTO=3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PUERTO+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/servidor.js"]
