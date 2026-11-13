# app-viajes — Grupo 7 · Variante G (flotas y zonas)

Plataforma de viajes con microservicios: el pasajero pide un viaje, dispatch se lo ofrece a choferes cercanos de flotas habilitadas en la zona, exactamente uno lo gana, y el viaje se sigue en tiempo real hasta el cobro.
Monorepo con npm workspaces: cada servicio es independiente (su propia base, su imagen, su despliegue), pero comparten repo, lockfile y CI.

Plan completo: [PLAN.md](PLAN.md). Decisiones: [docs/adr](docs/adr).

> **Arquitectura en revisión (13/11/2026).** El enunciado del Integrador cambió. El plan v2 propone pasar a un solo backend modular, pero falta que la cátedra confirme si exige microservicios: ver [docs/consultas-catedra.md](docs/consultas-catedra.md). Este README describe el código tal como está hoy.

Documentación:
- [docs/arquitectura.md](docs/arquitectura.md): por qué es un monorepo de microservicios y no un monolito.
- [docs/eventos.md](docs/eventos.md): RabbitMQ, outbox/inbox y el catálogo de eventos.
- [docs/consultas-catedra.md](docs/consultas-catedra.md): preguntas pendientes para la cátedra y qué asumimos mientras tanto.
- [docs/reparto.md](docs/reparto.md): quién hace qué (Ivan, Agos, Maxi), dependencias y reglas de colaboración.
- [docs/identity.md](docs/identity.md): contrato de identity, usuarios de prueba y comandos para PowerShell.
- [docs/repaso-problemas-centrales.html](docs/repaso-problemas-centrales.html): repaso de 6.3, 6.6 y la variante G con diagramas de tiempos (abrir en el navegador).

## Estado

| Pieza | Estado |
|---|---|
| `packages/kernel`, `packages/contracts`, `packages/platform` | listo (config, logs con requestId, errores, validación, JWT, health/ready, apagado ordenado) |
| `services/dispatch` — asignación única (6.3) | listo, con tests de concurrencia contra Postgres |
| `services/identity` (M1) | **parcial:** registro, login, JWT RS256, JWKS, seed y límite de intentos de login. Faltan refresh con rotación, logout y revocación ([detalle](docs/identity.md)) |
| drivers, location, trips, payments, notifications, reservations, gateway, realtime, web | pendiente |

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

Si `npm test` falla con «No pude migrar la base de test», el volumen de Postgres es anterior a esa base: las bases se crean solo la primera vez que arranca el contenedor. Se arregla recreándolo con `docker compose down -v` y `npm run infra:up` (borra los datos locales). Y si falta un paquete, `npm install` otra vez: cada servicio nuevo suma dependencias.

Solo los tests de dominio (sin Docker): `npm run test:dominio -w @viajes/dispatch` o `-w @viajes/identity`.

Correr identity y dispatch en desarrollo desde PowerShell (paso a paso en [docs/identity.md](docs/identity.md)). Cada servicio en su terminal, con `.env` cargado y su puerto fijo (identity 3001, dispatch 3005):

```powershell
npm run claves -w @viajes/identity
npm run local -- identity migrate:deploy
npm run local -- dispatch migrate:deploy
npm run local -- identity seed
npm run local -- identity
npm run local -- dispatch
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
