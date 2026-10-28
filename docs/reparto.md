# Reparto del desarrollo — Ivan, Agos y Maxi

Cada integrante es **dueño** de uno de los tres problemas centrales y de los servicios que lo rodean. Ser dueño no significa trabajar solo: la defensa es **individual** y cualquiera puede tener que explicar cualquier parte. Por eso valen las reglas de colaboración del final.

| | Problema central | Servicios | ADRs |
|---|---|---|---|
| **Ivan** | 6.3 Asignación única | dispatch, trips, reservations, mensajería (outbox/inbox), deploy | 1, 4 ✅, 6, 11 |
| **Agos** | Variante G: flotas y zonas | identity, drivers, gateway, realtime, tests de seguridad | 2, 3, 7, 9 |
| **Maxi** | 6.6 Tarea pesada | location, simulador y mediciones, payments, passengers, notifications | 5, 8, 10, 12 |

---

## Ivan

**Hecho (28/10):**
- Esqueleto del monorepo y `packages/kernel`, `contracts` y `platform`.
- dispatch con la asignación única: `FOR UPDATE`, reserva única del chofer, cancelación, vencimiento por barrido y 63 tests.
- docker-compose, Dockerfile, CI, una base por servicio, ADR 0004, `docs/arquitectura.md` y `docs/eventos.md`.

**Fase 1 (hasta el Control 3, ~18/11):**
- [ ] **Mensajería en `platform`:** relay del outbox hacia `viajes.events`, consumidor con inbox, declaración de colas, bindings y DLQ, y propagación de `x-request-id`. Lo usan todos los servicios, así que va **primero**.
- [ ] **Idempotency-Key en `platform`:** lock con `SET NX` en Redis, registro en la misma transacción que el efecto, y 422 si la misma clave llega con otro body. Maxi lo necesita para payments.
- [ ] **Resto de dispatch:**
  - consumidor de `TripFinished`/`TripCancelled` que llama a `liberarChofer`;
  - proyección chofer → flota → zonas a partir de los eventos de drivers;
  - job de BullMQ para el vencimiento de ofertas, con el barrido como respaldo;
  - adaptador HTTP de `BuscadorCandidatos` hacia location.
- [ ] **trips (M6):** máquina de estados con las transiciones explícitas y un test por cada una, arribo, inicio con QR de un solo uso, fin, cancelaciones e historial no destructivo.
- [ ] ADRs 1 (TypeScript + ESM), 6 (microservicios + RabbitMQ) y 11 (vencimiento de ofertas).

**Fase 2 (hasta el congelamiento, ~02/12):**
- [ ] **reservations (M9):** viajes programados, recordatorios y activación idempotente hacia dispatch.
- [ ] **Deploy:** imagen Docker liviana (hoy pesa 724 MB), Coolify con HTTPS y la colección Bruno de la demo.
- [ ] **PWA:** pantallas de pasajero (pedir viaje, estimación, seguimiento en vivo) y de operador.

## Agos

**Fase 0/1 (urgente):**
- [ ] **identity (M1). Es lo primero de todo, porque sin JWT nadie puede levantar su servicio en local:**
  - argon2id con parámetros declarados;
  - JWT RS256 con los claims `sub`, `rol` y `fleetId` (este último solo para `admin_flota`), con `issuer` y `audience`;
  - refresh con rotación, revocación con denylist de `jti` en Redis que **falla cerrado**, y `/.well-known/jwks.json`;
  - seed con un usuario de prueba por rol.
  - **Contrato ya fijado:** `packages/platform/src/autenticacion.ts` espera esos claims y estos roles: `pasajero | chofer | operador | admin | admin_flota`.
- [ ] **drivers (M3) + Variante G:**
  - choferes, vehículos, documentación y habilitación;
  - flotas, zonas habilitadas por flota y reporte por flota;
  - **carrera G:** `UPDATE ... WHERE active_count < max_active` + `CHECK`, con un test de 50 activaciones contra límite 10 → exactamente 10;
  - aislamiento por `fleetId` en el caso de uso (404 si se pide algo de otra flota, con su test);
  - eventos `DriverEnabled`, `FleetZoneEnabled`, etc., para la proyección de dispatch. Acordar el formato con Ivan.
- [ ] ADRs 2 (Postgres + Prisma), 3 (JWT) y 9 (límite de choferes por flota).

**Fase 2:**
- [ ] **gateway:** CORS restringido, helmet, rate limit con store en Redis y headers `RateLimit-*`, proxy, generación de `x-request-id` y OpenAPI agregada.
- [ ] **realtime:** SSE con ticket de un solo uso de 30 s, suscripción solo a los viajes propios, y reconexión con snapshot + `Last-Event-ID`. ADR 7 (SSE frente a WebSocket).
- [ ] **Tests de seguridad transversales:** IDOR, prototype pollution, SQLi y rate limit sobre todos los servicios.
- [ ] **PWA:** proyecto base (Vite, vite-plugin-pwa, router, stores de Zustand, cliente HTTP), login y pantallas de admin y de admin de flota.

## Maxi

**Fase 1:**
- [ ] **location (M4) + tarea pesada 6.6:**
  - **versión ingenua:** un `INSERT` por ping y haversine en JavaScript sobre todos los choferes;
  - **versión optimizada:** Redis `GEOADD`/`GEOSEARCH`, un ZSET de timestamps contra los choferes fantasma, y el historial por Redis Stream con escritura en lotes (`createMany`);
  - las dos se eligen con `LOCATION_STRATEGY`;
  - zonas con PostGIS y `GET /zones/resolve`; retención y privacidad de la ubicación;
  - endpoint de búsqueda de candidatos que va a consumir dispatch. Acordar el contrato con Ivan: el puerto actual es `buscar(origen, { excluir, limite }) → choferIds`.
- [ ] **Simulador y mediciones:** `tools/simulador-choferes` (500 choferes cada 2 s), `tools/carga` con autocannon, `/metrics` con el lag del event loop, y 3 corridas por escenario en `docs/mediciones.md`.
- [ ] **payments (M7):**
  - estimación y tarifa final con una sola función, en centavos enteros;
  - cobro simulado idempotente (usa la Idempotency-Key de Ivan);
  - reintegros y liquidación.
- [ ] ADRs 5 (tarea pesada), 8 (búsqueda geográfica) y 12 (retención de ubicaciones).

**Fase 2:**
- [ ] **passengers (M2):** perfil, direcciones frecuentes, preferencias y una calificación por viaje (índice único).
- [ ] **notifications (M8):** consumidor de eventos con registro de intentos y reintentos, comprobante en PDF y adaptador intercambiable.
- [ ] **PWA:** pantallas del chofer (disponible / no disponible, ubicación con `watchPosition`, ofertas por SSE).
- [ ] ADR 10 (almacenamiento de la idempotencia) y las mediciones finales.

---

## Dependencias entre los tres

| Quién espera | Qué | De quién | Cuándo |
|---|---|---|---|
| Todos | identity con JWKS funcionando | Agos | Lo antes posible |
| Todos | Mensajería (outbox relay + inbox) en `platform` | Ivan | Primera semana de la Fase 1 |
| Maxi (payments) | Idempotency-Key en `platform` | Ivan | Antes de arrancar el cobro |
| Ivan (dispatch) | Búsqueda de candidatos en location | Maxi | Contrato acordado en la semana 1; mientras tanto se usa `buscador-fijo` |
| Ivan (dispatch) | Eventos de drivers para la proyección | Agos | Contrato en `packages/contracts` |
| Ivan, Maxi (realtime en la PWA) | SSE funcionando | Agos | Fase 2 |

**Regla:** los contratos (esquemas Zod en `packages/contracts` y eventos en `docs/eventos.md`) se acuerdan y se mergean **antes** de implementar. Mientras tanto, cada uno trabaja con un adaptador falso, que para eso está la arquitectura hexagonal.

## Reglas de colaboración

1. **Una rama por tarea y un PR a `main`.** Nadie pushea directo a `main`. Para mergear, el CI tiene que estar en verde y al menos un integrante tiene que haber aprobado.
2. **Los PRs de un problema central (6.3, 6.6 y G) los revisan los otros dos.** Es la forma de que los tres puedan defender todo.
3. **Todos commitean en todas las áreas:** el reparto de la PWA y de los tests de seguridad ya lo asegura. Si alguien termina antes, toma tareas del que viene más atrasado.
4. **Defensa individual:** cada dueño le explica su problema central a los otros dos, con la [página de repaso](repaso-problemas-centrales.html) y su ADR, antes del Control 3.
5. **Un test de concurrencia tiene que fallar cuando se saca la protección.** Si no falla, el test no prueba nada; ver la demora en `services/dispatch/tests/soporte/demora.ts`.
6. **Siguen el patrón de dispatch:** `src/dominio` sin dependencias de infraestructura, `composicion.ts` como único lugar que elige adaptadores, tests de dominio en memoria y tests de concurrencia contra Postgres real.

## Fase 3 (ataque, ~09/12, y entrega, ~16/12)

- **Ataque cruzado al grupo 8,** cada uno sobre su especialidad:
  - Agos: autenticación, IDOR y rate limit;
  - Ivan: carreras, idempotencia y eventos;
  - Maxi: carga, abuso de ubicación y validación de montos.
- **Hallazgos del grupo 6 sobre nuestro sistema:** los corrige el dueño del servicio, con un test por hallazgo.
- **Mediciones finales** (Maxi) y tag `entrega-final` (Ivan).
