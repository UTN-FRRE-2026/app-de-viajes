# app-viajes — Grupo 7 · Variante G (flotas y zonas)

Plataforma de viajes con microservicios: el pasajero pide un viaje, dispatch se lo ofrece a choferes cercanos de flotas habilitadas en la zona, exactamente uno lo gana, y el viaje se sigue en tiempo real hasta el cobro.
Monorepo con npm workspaces: cada servicio es independiente (su propia base, su imagen, su despliegue), pero comparten repo, lockfile y CI.

Plan completo: [PLAN.md](PLAN.md). Decisiones: [docs/adr](docs/adr).

> **Arquitectura (13/11/2026).** El enunciado del Integrador cambió y la cátedra confirmó que exige como mínimo tres microservicios. Quedan `identity`, `dispatch` (viajes, flotas y tarifas) y `location`: ver la sección 2 del [plan](PLAN.md). Este README describe el código tal como está hoy.

Documentación:
- [docs/arquitectura.md](docs/arquitectura.md): por qué es un monorepo de microservicios y no un monolito.
- [docs/eventos.md](docs/eventos.md): diseño de eventos del plan original, con RabbitMQ (ya no vigente).
- [docs/consultas-catedra.md](docs/consultas-catedra.md): consultas a la cátedra, respuestas y qué asumimos en las que siguen abiertas.
- [docs/reparto.md](docs/reparto.md): quién hace qué (Ivan, Agos, Maxi), dependencias y reglas de colaboración.
- [docs/identity.md](docs/identity.md): contrato de identity, usuarios de prueba y comandos para PowerShell.
- [docs/location.md](docs/location.md): contrato de location, versiones ingenua y optimizada, contrato con dispatch y prueba manual en PowerShell.
- [docs/tarifas.md](docs/tarifas.md): tarifa en centavos enteros, estimación (`GET /tarifas/estimacion`), puerto de mapas y decisiones pendientes del equipo.
- [docs/mediciones.md](docs/mediciones.md): informe de mediciones de 6.6 (k6, ingenua frente a optimizada); cómo reproducirlas en [carga/README.md](carga/README.md).
- [docs/adr](docs/adr): decisiones de arquitectura (0001 TypeScript y ESM, 0004 asignación única, 0005 tarea pesada, 0006 tres microservicios).
- [docs/repaso-problemas-centrales.html](docs/repaso-problemas-centrales.html): repaso de 6.3, 6.6 y la variante G con diagramas de tiempos (abrir en el navegador).

## Estado

| Pieza | Estado |
|---|---|
| `packages/kernel`, `packages/contracts`, `packages/platform` | listo (config, logs con requestId, errores, validación, JWT, health/ready, apagado ordenado) |
| `services/dispatch` — asignación única (6.3) | listo, con tests de concurrencia contra Postgres |
| `services/identity` | listo para el alcance acordado: registro, login, JWT RS256, JWKS, seed, límite de intentos de login, refresh con rotación y logout ([detalle](docs/identity.md)) |
| `services/location` | ubicación de los choferes y búsqueda de cercanos, en versión ingenua (Postgres) y optimizada (Redis GEO + historial en lotes), medidas con k6 ([detalle](docs/location.md), [mediciones](docs/mediciones.md)). dispatch lo usa para buscar candidatos |
| flotas y tarifas (dentro de dispatch), `web` (React + nginx) | pendiente |

## Requisitos

Node 22 o superior y Docker con Compose. Los comandos son los mismos en Windows (PowerShell) y en Linux.

## Levantar el sistema

```bash
npm install
npm run setup     # .env, clave RS256, Postgres y Redis, bases que falten, migraciones y usuarios de prueba
npm run dev       # identity (3001), location (3004) y dispatch (3005) en una terminal, con recarga
```

- **`npm run setup`** se puede correr las veces que haga falta: cada paso es idempotente y ninguno borra datos.
  - Si no hay `.env`, lo copia de `.env.example`. Si hay uno viejo, le **agrega** las variables nuevas de `.env.example` y avisa cuáles, sin tocar las que ya tenía.
  - Genera la clave RS256 de identity si falta.
  - Levanta Postgres y Redis con Docker Compose y crea las bases que falten. El script de init de Postgres solo corre con el volumen vacío; un volumen anterior a un servicio queda sin su base. No hace falta `docker compose down -v`, que borra todos los datos.
  - Genera el cliente de Prisma, migra las tres bases de desarrollo y carga los usuarios de prueba ([docs/identity.md](docs/identity.md)).
  - Con `npm run setup -- --sin-docker` no toca Docker: Postgres y Redis los provee otro, por ejemplo el CI.
- **`npm run dev`** levanta los tres servicios en una sola terminal, con el `.env` cargado. Cada línea va con el nombre del servicio adelante. Ctrl+C los apaga ordenados. Si uno se cae, los otros siguen y tsx lo reinicia cuando guardás un archivo; el lanzador avisa cuando deja de responder y cuando vuelve. Si un puerto está ocupado, lo dice antes de arrancar.
- **`npm start`** hace lo mismo con el código compilado (`npm run build` antes). Acá, si uno se cae, apaga los otros dos y sale con error.
- **En contenedores**, en lugar de `npm run dev` o `npm start`: `docker compose up -d --build`. Usan las mismas bases ya migradas y la clave del `.env`.
- **Un solo servicio**, con el `.env` cargado y su puerto fijo: `npm run local -- identity` (o `location`, `dispatch`; solo en PowerShell). Más detalles en [docs/identity.md](docs/identity.md) y [docs/location.md](docs/location.md).

`DISPATCH_LOG_SQL=1` muestra cada query en el log, incluido el `SELECT ... FOR UPDATE`.

**Métricas:** los tres servicios publican `GET /metrics` en formato de Prometheus, con `Authorization: Bearer <METRICAS_TOKEN>` (del `.env`). Incluye el lag del event loop, la memoria y la duración por ruta; dispatch suma solicitudes, asignaciones, ofertas vencidas y el tiempo hasta la asignación. `/metrics` no se publica por nginx.

## Tests

```bash
npm run lint
npm run typecheck
npm test          # dominio en memoria + integración/concurrencia contra Postgres y Redis
```

`npm test` usa las bases `*_test` que crea `npm run setup`. Solo los tests de dominio, sin Docker: `npm run test:dominio -w @viajes/dispatch` (o `-w @viajes/identity`, `-w @viajes/location`).

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
