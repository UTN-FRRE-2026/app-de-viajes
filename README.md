# app-viajes — Grupo 7 · Variante G (flotas y zonas)

Plataforma de viajes con microservicios: el pasajero pide un viaje, dispatch se lo ofrece a choferes cercanos de flotas habilitadas en la zona, exactamente uno lo gana, y el viaje se sigue en tiempo real hasta el cobro.
Monorepo con npm workspaces: cada servicio es independiente (su propia base, su imagen, su despliegue), pero comparten repo, lockfile y CI.

Plan completo: [PLAN.md](PLAN.md). Decisiones: [docs/adr](docs/adr).

Documentación:
- [docs/arquitectura.md](docs/arquitectura.md): por qué es un monorepo de microservicios y no un monolito.
- [docs/eventos.md](docs/eventos.md): RabbitMQ, outbox/inbox y el catálogo de eventos.
- [docs/repaso-problemas-centrales.html](docs/repaso-problemas-centrales.html): repaso de 6.3, 6.6 y la variante G con diagramas de tiempos (abrir en el navegador).

## Estado

| Pieza | Estado |
|---|---|
| `packages/kernel`, `packages/contracts`, `packages/platform` | listo (config, logs con requestId, errores, validación, JWT, health/ready, apagado ordenado) |
| `services/dispatch` — asignación única (6.3) | listo, con tests de concurrencia contra Postgres |
| identity, drivers, location, trips, payments, notifications, reservations, gateway, realtime, web | pendiente |

## Requisitos

Node 22 o superior, Docker con Compose.

## Levantar y correr los tests

```bash
cp .env.example .env
npm install
npm run infra:up            # postgres (puerto 5434 del host), redis, rabbitmq
npm run lint
npm run typecheck
npm test                    # dominio en memoria + integración/concurrencia contra Postgres
```

Solo los tests de dominio (sin Docker): `npm run test:dominio -w @viajes/dispatch`.

Correr dispatch en desarrollo (sin identity todavía, la verificación de JWT necesita un JWKS):

```bash
cd services/dispatch
DATABASE_URL=postgresql://dispatch_svc:dispatch_dev@localhost:5434/dispatch npx prisma migrate deploy
npm run dev:dispatch        # con las variables de .env exportadas
```

`DISPATCH_LOG_SQL=1` muestra cada query en el log, incluido el `SELECT ... FOR UPDATE`.

## Estructura

```
packages/kernel      lo único que el dominio puede importar (ErrorDeDominio, Reloj, GeneradorId)
packages/contracts   esquemas Zod de requests y eventos (lista blanca con strictObject)
packages/platform    infraestructura HTTP compartida (el dominio no la importa: lo verifica ESLint)
services/<servicio>
  src/dominio/       entidades, casos de uso, puertos, errores — sin Express, Prisma ni Redis
  src/infra/         http, db (Prisma + SQL de locks), memoria, externos
  src/composicion.ts único lugar que elige adaptadores
  prisma/            schema y migraciones (una base por servicio)
  tests/             dominio, integracion, concurrencia, seguridad
infra/postgres/init  crea una base y un usuario por servicio
docs/adr             decisiones de arquitectura
```
