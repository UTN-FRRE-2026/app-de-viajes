# Plan — Plataforma de viajes (Grupo 7 · Variante G: Flotas y zonas operativas)

## Contexto

Hay que construir una plataforma de viajes al estilo de las apps conocidas (sin usar marcas) que cumpla **dos enunciados a la vez, en un mismo repositorio**:

1. **TP Final ProgIV**: Node 22 + Express (sin NestJS), arquitectura hexagonal, concurrencia (condiciones de carrera e idempotencia), seguridad, una tarea pesada medida, tests, ADRs, informe de mediciones, ataque cruzado y defensa oral individual. La evaluación se centra en el **backend bajo condiciones adversas**.
2. **TP Integrador**: plataforma distribuida de 9 módulos (M1–M9), contratos OpenAPI, RabbitMQ, Redis, imágenes OCI versionadas, cliente web responsivo y pruebas E2E.

Decisiones ya tomadas: **TypeScript + ESM**, **Express 5**, **PostgreSQL + Prisma**, **RabbitMQ + Redis**, **Zod**, **Zustand**, **React PWA**, **Docker Compose**, deploy en **VPS con Coolify**. Cada módulo es un **microservicio con hexagonal adentro**.

**Cronograma** (las semanas se cuentan desde el 23/09/2026; plan escrito el 21/10, actualizado el 28/10):
- Control 1 «Diseño»: ~07/10 (ya pasó, verificar que esté cubierto).
- **Control 2 «Núcleo»: ~28/10.**
- Control 3 «Problema difícil»: ~18/11.
- Congelamiento: ~02/12.
- Ataque: ~09/12.
- Entrega: ~16/12.
- Defensa: ~23/12.

Las fechas reales se confirman en el aula virtual.

## Estado al 28/10

**Hecho:**
- Esqueleto del monorepo: `packages/kernel`, `contracts` y `platform` (config que sale con código ≠ 0, logs con requestId, errores únicos, validación estricta, JWT, `/health` y `/ready`, apagado ordenado), docker-compose, Dockerfile genérico y CI.
- Una base y un usuario por servicio (`infra/postgres/init`), con `REVOKE ALL ... FROM PUBLIC`.
- `services/dispatch` con la asignación única (3.1): crear solicitud, aceptar oferta, cancelar, vencimiento de ofertas por barrido y `liberarChofer`.
- 63 tests en verde: 44 de dominio en memoria y 19 contra Postgres real (concurrencia, integración y seguridad básica).
- [ADR 0004](docs/adr/0004-asignacion-unica.md), [arquitectura.md](docs/arquitectura.md), [eventos.md](docs/eventos.md) y la [página de repaso de los problemas centrales](docs/repaso-problemas-centrales.html).

**Cambios respecto del plan original:**
- La reserva del chofer usa `INSERT ... ON CONFLICT DO NOTHING RETURNING`: 0 filas → 409. Espera igual que el `UNIQUE`, pero no deja la transacción abortada.
- Los tests de concurrencia usan una demora de 15 ms, solo en tests (`tests/soporte/demora.ts`), dentro de la transacción. Sin ella, el test de 50 aceptaciones pasaba aunque se sacara el `FOR UPDATE`. Ahora se comprobó que falla si falta cualquiera de las dos protecciones.
- Versiones fijadas: Prisma 7.10.1 (driver adapter `pg`), TypeScript 5.9, vitest 4. Postgres escucha en el puerto 5434 del host.
- Columnas de estado `text` con `CHECK` en vez de enums de Postgres, para no necesitar casts en el SQL crudo.

**Pendiente de la Fase 0:** identity, drivers con flotas, ADRs 1 a 3, `modelo.md`, probar el CI en GitHub y achicar la imagen Docker (hoy pesa 724 MB).

---

## 1. Arquitectura general

```
                    ┌─────────────── PWA React (apps/web, nginx) ───────────────┐
                    │  pasajero · chofer · operador · admin · admin de flota    │
                    └───────────────┬───────────────────────────┬───────────────┘
                              HTTPS │ REST                      │ SSE
                    ┌───────────────▼──────────┐   ┌────────────▼─────────────┐
                    │ gateway (Express)        │   │ realtime (Express + SSE) │
                    │ CORS, helmet, rate limit,│   │ consume eventos Rabbit   │
                    │ x-request-id, proxy      │   │ → push a pasajero/chofer │
                    └───────────────┬──────────┘   └────────────▲─────────────┘
         ┌──────────┬──────────┬────┴─────┬──────────┬──────────┬────────┬────────┬─────────┐
      identity  passengers  drivers   location   dispatch    trips   payments notifications reservations
        (M1)       (M2)    (M3 + G)    (M4)       (M5)       (M6)     (M7)      (M8)        (M9)
         │ cada uno con su BD Postgres propia (un usuario por BD; ninguno lee la BD de otro)
         └──────── RabbitMQ (exchange topic `viajes.events`, outbox/inbox) ── Redis (GEO, idempotencia, BullMQ, rate limit)
```

| Servicio | Responsabilidad | Invariantes / puntos clave |
|---|---|---|
| **identity** (M1) | Registro, login, roles, JWT RS256 + refresh con rotación, revocación, JWKS | argon2id con parámetros declarados; denylist de `jti` en Redis que **falla cerrado** |
| **passengers** (M2) | Perfil, direcciones frecuentes, preferencias, calificación al chofer | Una calificación por viaje (índice único) |
| **drivers** (M3 + **G**) | Chofer, vehículos, documentación, habilitación, **flotas, zonas habilitadas por flota, límite de activos** | Carrera G: `UPDATE ... WHERE active_count < max` + `CHECK` |
| **location** (M4) | Ubicación vigente (Redis GEO + TTL), historial, zonas (polígonos PostGIS), ETA y distancia (puerto de mapas) | **Tarea pesada 6.6**; privacidad de la ubicación |
| **dispatch** (M5) | Solicitud, candidatos, ofertas con vencimiento, **asignación única**, lock "chofer con viaje activo" | **Problema central 6.3** |
| **trips** (M6) | Máquina de estados, arribo, inicio con QR de un solo uso, fin, cancelaciones, historial no destructivo | Transiciones válidas explícitas, con un test por cada una |
| **payments** (M7) | Estimación y tarifa final (una sola función), cobro simulado idempotente, reintegros, liquidación | Montos en **centavos enteros** |
| **notifications** (M8) | Consume eventos, registra intentos/reintentos, comprobante PDF, tickets | El adaptador se puede cambiar (consola, archivo o web push) |
| **reservations** (M9) | Viajes programados, recordatorios, activación idempotente hacia dispatch | Una reserva genera como máximo una solicitud |
| **gateway** | Punto de entrada único: CORS restringido, helmet, rate limit (store en Redis), proxy, OpenAPI agregada | — |
| **realtime** | SSE autenticado con ticket de corta duración; al reconectar se resincroniza | — |

**Por qué la asignación vive entera en dispatch:** el viaje y el chofer son los dos recursos que se bloquean juntos. Si estuvieran en BDs distintas haría falta una transacción distribuida. Por eso dispatch es dueño de la solicitud y también del lock `driver_active_assignment`. trips recibe `TripAssigned` y libera el lock emitiendo `TripFinished` o `TripCancelled`; esos consumidores son idempotentes.

**Projección en dispatch:** dispatch mantiene una vista de lectura (chofer → flota, habilitado, tipo de vehículo; flota → zonas) alimentada por eventos de drivers. Así evita llamadas síncronas en el camino caliente de la búsqueda de candidatos.

---

## 2. Estructura del monorepo (npm workspaces, un solo `package-lock.json`)

```
app-viajes/
├─ package.json                 # engines node 22, workspaces, scripts raíz
├─ docker-compose.yml           # infra + servicios + web (un solo `docker compose up`)
├─ docker-compose.dev.yml       # override con hot reload
├─ Dockerfile                   # multi-stage genérico con ARG SERVICE, usuario no root, HEALTHCHECK
├─ .env.example
├─ packages/
│  ├─ kernel/       # SOLO cosas que el dominio puede importar: DomainError, Result, puerto Reloj, Id, Money(centavos)
│  ├─ platform/     # infraestructura compartida (el dominio no la importa):
│  │                #   config (zod + exit≠0), logger pino + AsyncLocalStorage, middleware de errores único,
│  │                #   idempotencia, /health y /ready, apagado ordenado SIGTERM, verificación JWT (JWKS),
│  │                #   autorización por rol, outbox relay + consumer con inbox, monitorEventLoopDelay → /metrics
│  └─ contracts/    # esquemas Zod de requests/eventos compartidos → OpenAPI (zod-to-openapi) y tipos para la PWA
├─ services/<nombre>/           # misma forma en los 9 servicios + gateway + realtime
│  ├─ prisma/schema.prisma + migrations/
│  ├─ src/dominio/{entidades,casos-uso,puertos,errores}/
│  ├─ src/infra/{http,db,mensajeria,externos,memoria}/
│  ├─ src/config/
│  ├─ src/composicion.ts        # único lugar que conoce adaptadores reales y falsos (elige por env)
│  └─ src/servidor.ts
│  └─ tests/{dominio,integracion,seguridad,concurrencia}/
├─ apps/web/                    # React + Vite + vite-plugin-pwa + Zustand + TanStack Query + Leaflet/OSM
├─ tools/simulador-choferes/     # 500+ choferes enviando ubicación cada 2 s
├─ tools/carga/                  # escenarios de autocannon/k6 y scripts de medición
├─ demo/                         # colección Bruno (.bru) de la demo
└─ docs/{adr/,modelo.md,api.md,eventos.md,mediciones.md,ataque.md,trazabilidad.md}
```

**Aislamiento del dominio, verificable:** una regla de ESLint `no-restricted-imports` en `src/dominio/**` prohíbe `express`, `@prisma/client`, `ioredis`, `amqplib`, `bullmq` y `@viajes/platform`. Si se rompe, `npm run lint` falla.

**Prisma en hexagonal:**
- `PrismaClient` solo se usa en `infra/db`.
- Los bloqueos (`SELECT ... FOR UPDATE`) y PostGIS van con `$queryRaw` (parametrizado) dentro de `$transaction` interactiva. Las columnas geométricas se declaran como `Unsupported("geometry")`.
- Se activa el log de queries para poder **mostrar el SQL**, como pide la defensa.
- `/ready` verifica la conexión a la BD y que no haya migraciones pendientes (tabla `_prisma_migrations`).

**Postgres:** se usa una instancia `postgis/postgis:16` con **una base y un usuario por servicio**, creados por un script de init. Cumple la propiedad de datos: ningún servicio puede leer la BD de otro.

---

## 3. Problemas centrales y cómo se resuelven

### 3.1 Asignación única (6.3) — dispatch
- Tablas:
  - `ride_requests(status, version)`.
  - `offers(request_id, driver_id, expires_at, status)`.
  - `driver_active_assignment(driver_id UNIQUE, request_id UNIQUE)`.
  - Índice único parcial «un pedido activo por pasajero».
- **Aceptar oferta**, todo en una transacción:
  1. `SELECT ... FROM ride_requests WHERE id=$1 FOR UPDATE`. **Orden fijo: primero la solicitud, después el chofer.**
  2. Validar que la solicitud esté en `BUSCANDO`, que la oferta esté vigente y sea del chofer.
  3. `INSERT driver_active_assignment`. Si choca con la restricción única, se responde 409 «chofer con viaje activo».
  4. `UPDATE` de la solicitud a `ASIGNADO`, y en la misma transacción se escribe `TripAssigned` en el outbox.
- **Cancelar:** primero toma el mismo `FOR UPDATE` sobre la solicitud. Hay dos resultados documentados:
  - (a) gana la cancelación: queda `CANCELADO_PASAJERO` y la aceptación recibe 409;
  - (b) gana la aceptación: la cancelación pasa a ser una cancelación de un viaje asignado y libera el lock del chofer en la misma transacción.
- **Por qué no hay interbloqueo:** todos los caminos bloquean la solicitud antes que el chofer. El lock del chofer no es un lock de fila sino una restricción única, así que no hay un segundo lock que se pueda cruzar.
- **Vencimiento de ofertas:** un job diferido de BullMQ por oferta, más un *sweeper* periódico de respaldo. Al vencer se pasa al siguiente candidato o a `SIN_CHOFERES`. No depende de que el cliente avise.
- **Tests:**
  - 50 aceptaciones simultáneas sobre la misma solicitud: exactamente 1 → 200 y 49 → 409, con el estado de la BD verificado.
  - Cancelación contra aceptación concurrentes.
  - Un chofer con viaje activo no puede aceptar otro.

### 3.2 Tarea pesada (6.6) — location
- **Versión ingenua** (`LOCATION_STRATEGY=ingenua`):
  - Cada ping hace un `INSERT` en Postgres.
  - La búsqueda trae todos los choferes y calcula haversine en JS, de forma síncrona y ordenando en el mismo proceso.
- **Versión final** (`LOCATION_STRATEGY=optimizada`, cambia solo en `composicion.ts`):
  - La posición vigente va a Redis `GEOADD`, con un ZSET de timestamps para el TTL que evita choferes fantasma.
  - El historial se escribe en un Redis Stream y un worker lo inserta en lotes (`createMany`).
  - La búsqueda usa `GEOSEARCH` con radio y luego filtra por zona y flota.
- **Retención:**
  - Los puntos crudos se guardan solo mientras hay un viaje activo, y se conservan 30 días.
  - Las pings de choferes disponibles se descartan a las 24 h.
  - Todo esto se documenta en el ADR.
- **Simulador** en `tools/simulador-choferes`: 500 choferes cada 2 s durante 5 minutos o más, todo configurable. Al mismo tiempo, autocannon pega contra `POST /rides`.
- **Métricas:**
  - p50, p95 y p99 de solicitud de viaje;
  - tiempo hasta la asignación;
  - req/s;
  - lag del event loop (`monitorEventLoopDelay` expuesto en `/metrics`);
  - RSS.
  - Se hacen 3 corridas por escenario.

### 3.3 Variante G — Flotas y zonas
- Rol `admin_flota` con el claim `fleetId` en el JWT. **Todas** las queries de flota filtran por ese `fleetId` en el caso de uso, no en la ruta. Pedir un recurso de otra flota devuelve 404, y hay test.
- `zones` (polígonos PostGIS) viven en location, con `GET /zones/resolve?lat&lng`. `fleet_zones` vive en drivers. dispatch solo ofrece el viaje a choferes cuya flota tiene habilitada la zona de origen.
- **Carrera G:** `UPDATE fleets SET active_count = active_count + 1 WHERE id=$1 AND active_count < max_active RETURNING *`, más `CHECK (active_count <= max_active)` como red de seguridad. Test: 50 activaciones concurrentes con límite 10 → exactamente 10 activos.
- Reporte por flota: viajes, choferes activos y facturación.

### 3.4 Transversales
- **Idempotency-Key** en todo lo que crea, cobra o dispara un efecto:
  - Redis `SET NX` como lock mientras el pedido está en vuelo; un duplicado concurrente recibe 409.
  - Se guarda un registro en Postgres del servicio **en la misma transacción que el efecto**, con hash del body y la respuesta.
  - Un reintento recibe la respuesta guardada; la misma clave con otro body devuelve 422.
- **Eventos:** se publican con outbox, *at-least-once*. Los consumidores deduplican con una tabla inbox (`message_id` único) en la misma transacción. El catálogo vive en `docs/eventos.md`.
- **Seguridad:**
  - Zod `.strict()` en body, params, query y headers relevantes. Es una lista blanca, así que `__proto__` y `constructor` se rechazan como claves no declaradas, sin depender de una lista negra.
  - Límite de tamaño de body.
  - Prisma y `$queryRaw` con plantillas parametrizadas.
  - Rate limit 429 con headers `RateLimit-*` en login, solicitud de viaje y ubicación.
  - Helmet y CORS limitado a los orígenes de la PWA.
  - `npm audit` en CI.
- **Observabilidad:**
  - El gateway genera `x-request-id` y se propaga a los servicios y a los mensajes de Rabbit.
  - Cada servicio lo guarda en AsyncLocalStorage y pino lo incluye en cada línea JSON.
  - La respuesta de error es `{error:{code,message,requestId}}`, sin stack trace.
- **Ciclo de vida:**
  - La config se valida con Zod al arrancar y, si falta algo, el proceso sale con código ≠ 0 y nombra la variable.
  - `/health` y `/ready` están separados.
  - Con SIGTERM el servicio deja de aceptar conexiones, drena los pedidos, cierra Prisma, Redis y Rabbit, y tiene un timeout que se registra en el log.
- **Tiempo real (SSE):**
  - `GET /stream?ticket=...`. El ticket es de un solo uso y dura 30 s, se emite por REST autenticado, y solo se suscribe a los viajes propios.
  - Al reconectar, el cliente pide primero el snapshot `GET /trips/:id` y después se vuelve a suscribir usando `Last-Event-ID`.

---

## 4. Frontend PWA (apps/web) — **después** del núcleo backend
- React + Vite + `vite-plugin-pwa` (manifest, service worker, instalable en Android e iOS).
- Zustand para sesión y viaje actual; TanStack Query para datos del servidor.
- Leaflet con OpenStreetMap: sin costo y sin claves.
- Pantallas por rol:
  - pasajero: pedir viaje, estimación, seguimiento en vivo;
  - chofer: disponible/no disponible, envía ubicación con `watchPosition` cada ~3 s, recibe ofertas por SSE;
  - operador: viajes en curso y cancelación con motivo;
  - admin: tarifas, zonas y habilitaciones;
  - admin de flota: sus choferes y su reporte.
- Limitación a documentar: una PWA no envía la ubicación en segundo plano (sobre todo en iOS). El chofer tiene que tener la app abierta. La demo de «oferta que vence con la app cerrada» funciona igual porque el vencimiento ocurre en el servidor.

---

## 5. Docker, CI y despliegue
- `docker compose up` levanta postgres, redis, rabbitmq (con management), los 9 servicios, gateway, realtime y web, todos con healthcheck y `depends_on: condition: service_healthy`.
- Scripts raíz:
  - `npm run setup`: espera la infra, crea las BDs, `prisma migrate deploy` en cada servicio y carga el seed con usuarios de prueba por rol.
  - `npm test`: vitest en todos los workspaces (dominio, integración, seguridad, concurrencia).
  - `npm run dev`, `npm start`, `npm run lint`, `npm run seed`.
  - `npm run sim:choferes` y `npm run medir`.
- GitHub Actions corre lint, tests (con servicios de postgres, redis y rabbit), `npm audit`, y hace build y push de imágenes con **tag semver** a GHCR (TP2: registry).
- Coolify:
  - Recurso «Docker Compose» desde el repo.
  - Traefik expone solo `web` y `gateway` (y `realtime`) con HTTPS por Let's Encrypt.
  - Los secretos van en variables de Coolify.
  - VPS recomendado: **4 GB de RAM como mínimo**.

---

## 6. Documentación obligatoria
- README:
  - qué hace el sistema, en 5 líneas;
  - la secuencia de la sección 2.4;
  - usuarios de prueba;
  - tabla de roles y permisos (5 roles);
  - índice de `docs`.
- ADRs, en el formato de la sección 7.1 con alternativas reales:
  1. TypeScript + ESM.
  2. Postgres + Prisma, una BD por servicio, y SQL crudo para locks y PostGIS.
  3. JWT RS256 + refresh, y autorización por recurso.
  4. Asignación con `FOR UPDATE` de la solicitud + restricción única de chofer activo, con el orden de los locks.
  5. Tarea pesada con Redis GEO + historial por cola y escritura en lotes.
  6. Microservicios + RabbitMQ con outbox/inbox.
  7. SSE frente a WebSocket.
  8. Búsqueda geográfica: Redis GEO frente a PostGIS frente a geohash.
  9. Límite de choferes por flota.
  10. Almacenamiento de la idempotencia.
  11. Vencimiento de ofertas (BullMQ + sweeper).
  12. Retención de ubicaciones.
- `modelo.md` con diagramas mermaid: entidades, estados del viaje y de la solicitud.
- `api.md`, que enlaza la OpenAPI de cada servicio y Swagger UI.
- `eventos.md`, `mediciones.md`, `ataque.md` y `trazabilidad.md` (requerimiento → endpoint → regla → test, que pide el TP integrador).

---

## 7. Hoja de ruta (la idea es que los 3 integrantes commiteen en todas las áreas, con PR y revisión)

**Fase 0 — antes del Control 2 (~28/10):**
- Esqueleto del monorepo, `packages/platform` completo (config, logger+ALS, errores, health/ready, SIGTERM, JWT), docker-compose e infra.
- identity completo.
- drivers básico, con flotas.
- Dominio de dispatch con tests en memoria.
- ADRs 1 a 3, `modelo.md` y CI básico.

**Fase 1 — antes del Control 3 (~18/11):**
- dispatch con la asignación real y sus tests de concurrencia.
- location en sus dos versiones, el simulador y la primera medición.
- trips con la máquina de estados.
- payments con tarifa y cobro idempotente.
- Carrera G.
- Outbox/inbox con RabbitMQ.
- ADRs 4, 5, 8, 9 y 11.

**Fase 2 — antes del Congelamiento (~02/12):**
- realtime con SSE, notifications y reservations (M9).
- Tests de seguridad: IDOR, prototype pollution, SQLi y rate limit.
- PWA.
- Deploy en Coolify, colección Bruno y OpenAPI.
- Usuarios de prueba publicados para el grupo atacante.

**Fase 3:**
- Ataque cruzado: nosotros atacamos al grupo 8 y el grupo 6 nos ataca a nosotros.
- Correcciones con un test por hallazgo.
- Mediciones finales (3 corridas) y tag `entrega-final`.

**Prioridad si falta tiempo:** primero lo que pesa en la nota de ProgIV (6.3, 6.6, la variante G y los 8 bloques comunes). M8 y M9 se hacen con alcance mínimo pero completo.

---

## 8. Verificación end-to-end
1. Clon limpio, `cp .env.example .env`, `docker compose up -d`, `npm run setup`, `npm test` en verde.
2. Borrar una variable de entorno: el servicio sale con un mensaje claro y código ≠ 0.
3. Mandar SIGTERM durante un pedido lento: el log muestra que el pedido terminó antes de que el proceso saliera.
4. Recorrer la colección Bruno:
   - ciclo completo de un viaje con seguimiento SSE;
   - oferta que vence y pasa al siguiente chofer;
   - IDOR rechazado sobre ubicación y sobre otra flota;
   - la misma Idempotency-Key dos veces produce un solo efecto.
5. Tests de concurrencia:
   - 50 aceptaciones → 1 asignación;
   - cancelación contra aceptación;
   - 50 activaciones contra límite 10 → exactamente 10.
6. `npm run sim:choferes` + `npm run medir`, en versión ingenua y optimizada; los números van a `docs/mediciones.md`.
7. Instalar la PWA en un celular desde la URL de Coolify y hacer un viaje con dos dispositivos (pasajero y chofer).

---

## Dudas abiertas (no bloquean el arranque)
- **TP2 del integrador** pide integrarse con módulos *de otros grupos*. Si nosotros hacemos los 9, hay que confirmar con la cátedra cómo se evalúa esa parte (por ejemplo, consumiendo la imagen de otro grupo para algún módulo).
- Fechas exactas de los controles, y si el Control 1 ya fue presentado.
- Especificaciones del VPS: RAM disponible y si ya tienen dominio para HTTPS.
