# Plan v2 — Plataforma de viajes (Grupo 7 · Variante G: Flotas y zonas operativas)

Reescrito el 13/11/2026. Reemplaza al plan de nueve microservicios del 21/10 (queda en el historial de Git).

> **La cátedra confirmó de palabra que exige como mínimo tres microservicios, cada uno en su contenedor.** El monolito modular que proponía la primera versión de este plan quedó descartado. La arquitectura es `identity`, `dispatch` y `location` (sección 2). Las demás consultas siguen abiertas en [docs/consultas-catedra.md](docs/consultas-catedra.md).

## 1. Qué cambió

El **TP Integrador** dejó de ser la plataforma distribuida de 9 módulos (M1–M9). La versión nueva («preliminar 2.0») es el **mismo enunciado de ProgIV** (secciones 1 a 4, 6 y 7, comparadas oración por oración: sin diferencias de contenido) más una **rúbrica propia de 100 puntos**.

| | TP Final ProgIV (v1.0) | TP Integrador (v2.0 preliminar) |
|---|---|---|
| Sistema | Plataforma de viajes, variante G | El mismo |
| Requisitos técnicos | Secciones 4 y 6 | Las mismas, copiadas |
| Nota grupal | 40 % sistema + 20 % artefactos (ADR, mediciones, ataque, Git) | **60 puntos:** 3 temas de exposiciones (15), framework frontend (5), Playwright E2E (10), CI + SAST (10), k6 carga y estrés (10), Grafana Cloud (10) |
| Nota individual | Defensa oral 40 % (hay que sacar 6 o más) | Coloquio 40 puntos |
| Ataque cruzado, defensa, cronograma | Secciones 8, 9 y 10 | No están en el documento |

**Ya no se exige:** los 9 módulos, un contrato OpenAPI por módulo, RabbitMQ, una base por servicio, imágenes OCI con semver, integración con módulos de otros grupos y la matriz de trazabilidad.

**Se sigue exigiendo, aunque el documento no lo diga:** un mínimo de tres microservicios, cada uno en su contenedor (confirmado de palabra por la cátedra).

**Se suma:** frontend con framework (antes era opcional), Playwright, SAST en el CI, k6, Grafana Cloud y tres temas de las exposiciones.

### Inconsistencias entre los documentos (cómo las resolvemos)

| Qué dice | Cómo lo tomamos |
|---|---|
| ProgIV 1.4 (y la copia en el Integrador): «el frontend no suma nota». La rúbrica del Integrador le da 5 puntos y Playwright (10) lo necesita. | Se hace un frontend **mínimo**, después del núcleo. La cátedra confirmó que alcanza: lo que importa es el backend y DevOps. |
| ProgIV admite autocannon o k6; el Integrador pide k6. | **k6 para todo**: simulador de choferes, mediciones de 6.6 y escenarios de estrés. La cátedra confirmó que un escenario de k6 propio vale como simulador. |
| El Integrador cita `docs/ataque.md`, «sección 8» y «el cronograma de la sección 10», pero no trae esas secciones. | Siguen vigentes por ProgIV: la cátedra confirmó que hay ataque cruzado. Las fechas se fueron corriendo y el plan no depende de ellas (sección 6). |
| La sección 6 se titula «Comisión 1» y el resto del texto dice que viajes es de la Comisión 2. «17. Artefactos» es la sección 7. | Errores de tipeo. Somos el grupo 7 de la tabla de 6 (Stabile, Jara, Sanchez → variante G). |
| La tabla de 6 tiene 8 grupos, pero 6.7 define una variante I para un «grupo 9». | Si existe el grupo 9, cambia el emparejamiento del ataque (hoy: atacamos al 8, nos ataca el 6). **Preguntar.** |
| Ningún documento menciona microservicios, pero el profesor confirmó de palabra que exige tres como mínimo. | Se hacen tres (sección 2). Pedir la confirmación por escrito. |
| El Integrador dice «versión preliminar». | Puede cambiar otra vez: la rúbrica se implementa en capas que no tocan el núcleo. |

## 2. Decisión: tres microservicios

**Respuesta de la cátedra (verbal):** el sistema tiene que tener **como mínimo tres microservicios**, cada uno corriendo en **su propio contenedor**. Pueden compartir la base de datos. El monolito modular queda **descartado**: el profesor dijo expresamente que no lo quiere. Como ninguno de los dos enunciados lo dice, conviene pedirlo por escrito ([consulta 1](docs/consultas-catedra.md)).

Nos quedamos en el mínimo: tres servicios. Somos tres y queda poco tiempo.

| Servicio | Qué resuelve | Estado | Dueño |
|---|---|---|---|
| **identity** (3001) | Registro, login, JWT RS256, refresh, roles, JWKS | Hecho en su mayor parte | Agos |
| **dispatch** (3005) | **viajes:** solicitud, ofertas, asignación única (6.3), estados, historial, tiempo real. **flotas:** choferes, vehículos, flotas, zonas y límite (variante G). **tarifas:** tarifa y cobro simulado | Viajes parcial; flotas y tarifas faltan | Ivan (viajes), Agos (flotas), Maxi (tarifas) |
| **location** (3004) | Pings de ubicación, búsqueda de candidatos, tarea pesada (6.6), retención | Falta | Maxi |

Por qué estos límites:
- **identity y dispatch ya existen como servicios separados**, con su contenedor, su base y sus tests en el CI. No se mueve código: la consolidación en `services/api` queda cancelada.
- **location es el tercero porque es la tarea pesada.** 500 choferes mandan 250 pings por segundo; en un proceso propio no le sacan event loop a la asignación de viajes. Es un argumento que se mide: el lag de dispatch con el simulador corriendo.
- **flotas y tarifas quedan dentro de dispatch** porque comparten transacción con el viaje. El filtro de candidatos por flota y zona, la liberación del chofer y el cobro al finalizar se resuelven en una sola base. Separarlos obligaría a transacciones distribuidas que nadie pide.

### Bases de datos

La cátedra permite compartir la base. Mantenemos lo que ya está construido: **un contenedor Postgres con una base y un usuario por servicio** (`identity`, `dispatch`; se agrega `location`). No cuesta trabajo nuevo y evita el acoplamiento por datos: ningún servicio lee tablas de otro.

### Cómo se comunican

| De → a | Mecanismo | Para qué |
|---|---|---|
| dispatch y location → identity | JWKS (`/.well-known/jwks.json`), **ya hecho** | Verificar el token sin llamar a identity en cada pedido |
| dispatch → location | HTTP interno `GET /interno/candidatos`, con timeout y token de servicio | Choferes cercanos al origen |
| location → dispatch | Redis Pub/Sub, un canal por chofer | Posición en vivo para el seguimiento |
| dispatch → web | SSE | Estados del viaje y posición del chofer |

- **Sin RabbitMQ.** Nadie lo exige y ningún código lo usa: sale del Compose. La tabla `outbox` se conserva en dispatch como fuente de los eventos de tiempo real.
- **Candidatos:** location devuelve los choferes más cercanos, ordenados por distancia. dispatch los filtra en su propia base: habilitado, disponible, sin viaje activo y de una flota con la zona del origen habilitada. Así location no necesita saber nada de flotas ni de viajes. Si el filtro deja pocos, se pide un lote más grande; va en el ADR 0008.
- **Si location no responde** dentro del timeout, la solicitud devuelve 503 y no crea el viaje (falla cerrado).
- **Si identity se cae,** dispatch y location siguen verificando tokens con las claves que tienen en caché.
- **`fleetId`:** identity lo guarda sin clave foránea (la flota vive en dispatch) y lo pone en el token del `admin_flota`. dispatch valida que la flota exista cuando se usa.

### Punto de entrada

Un contenedor **web** (nginx) sirve el frontend y hace de reverse proxy: `/api/identity/`, `/api/viajes/` y `/api/ubicacion/`. Es el único puerto que se publica al grupo atacante.
- `/interno/*` y `/metrics` no pasan por nginx.
- SSE necesita `proxy_buffering off`.
- Los servicios tienen que confiar en el `X-Forwarded-For` de nginx (`trust proxy`), o el límite de tasa por IP vería una sola IP.

```
 Navegador ──▶ web (nginx: React + reverse proxy) ─┬─▶ identity  (3001) ── base identity
                                                   ├─▶ dispatch  (3005) ── base dispatch (PostGIS)
                                                   └─▶ location  (3004) ── base location · Redis GEO
 dispatch ── HTTP interno ──▶ location        location ── Redis Pub/Sub ──▶ dispatch ── SSE ──▶ navegador
 dispatch, location ── JWKS ──▶ identity      Redis: GEO, idempotencia, rate limit, caché, pub/sub
 k6 (carga/) ──▶ servicios     Playwright (e2e/) ──▶ web     Grafana Alloy ──▶ Grafana Cloud (opcional, por perfil)
```

Contenedores del Compose: `postgres`, `redis`, `identity`, `dispatch`, `location`, `web` y, con el perfil `obs`, `alloy`.

### Estructura objetivo

```
packages/kernel · platform · contracts      se conservan
services/identity/                          como está
services/dispatch/                          viajes (como está) + flotas + tarifas
services/location/                          nuevo, con la misma forma que los otros dos
  prisma/ · src/dominio/ · src/infra/ · src/config/ · src/composicion.ts · src/servidor.ts
  tests/{dominio,integracion,seguridad,concurrencia}/
apps/web/            React + Vite + Zustand, servido por nginx
e2e/                 Playwright
carga/               k6: simulador de choferes, carga y estrés
observabilidad/      configuración de Alloy y dashboards exportados (JSON)
demo/                colección de requests de la demo
docs/                adr/, modelo.md, api.md, mediciones.md, ataque.md, evidencias/
```

Dentro de dispatch, flotas y tarifas respetan las mismas capas (`dominio/`, `infra/`), con una subcarpeta por módulo donde haga falta. La regla de ESLint que impide al dominio importar infraestructura no cambia.

### Qué pasa con lo que ya está hecho

| Hoy | Destino | Trabajo |
|---|---|---|
| `packages/kernel`, `platform`, `contracts` | Igual | Sumar a `platform`: helmet, CORS, rate limit genérico, log por pedido, métricas, idempotencia, validación de encabezados y cliente HTTP interno con timeout. Sumar a `contracts` el contrato de location |
| `services/identity` (registro, login, refresh, argon2id, RS256, JWKS, seed) | Igual | Logout y revocación |
| `services/dispatch` (dominio, repositorio, 63 tests) | Igual | `SolicitudViaje` pasa a ser el viaje completo (ver 3.1); se agregan flotas y tarifas |
| Verificación de tokens por JWKS | Igual | La usa también location |
| Tabla `outbox` | Se conserva | Fuente de los eventos de tiempo real; sin relay a RabbitMQ ni inbox |
| Barrido de ofertas vencidas | Se conserva tal cual | No hace falta BullMQ |
| `docker-compose.yml`, `infra/postgres/init` | Ajustar | Fuera `rabbitmq`; entran `location` y `web`; base y usuario `location` |
| `Dockerfile` genérico | Igual | `SERVICE=location` |
| CI (typecheck, lint, tests, audit) | Ampliar | Base de test de location; jobs de E2E y SAST |
| ADR 0004 | Ajustar formato | Le faltan «quiénes participaron» y «qué nos haría cambiar de decisión»; sacar las menciones a M5 |
| `docs/arquitectura.md`, `docs/eventos.md`, README | Actualizar | Describen nueve servicios y RabbitMQ |

El ADR 0006 registra la decisión con sus alternativas reales: monolito modular (descartado por la cátedra), los nueve servicios del plan original (descartados por tiempo) y otros límites posibles, como flotas dentro de identity.

**Se descarta del plan original:** los servicios separados de drivers, trips y payments (quedan dentro de dispatch) y passengers (M2: el pasajero es un usuario de identity), notifications con PDF y tickets (M8), reservations (M9: los viajes programados son la variante B, no la nuestra), realtime como servicio, el gateway propio (lo reemplaza nginx), QR de un solo uso, reintegros y liquidación, denylist de `jti`, RabbitMQ con inbox, BullMQ, PWA instalable, imágenes en GHCR y `trazabilidad.md`.

## 3. Diseño por servicio y módulo

### 3.1 dispatch · viajes — asignación única (6.3) y ciclo de vida

- Una sola entidad con toda la máquina de estados, en la misma fila que ya se bloquea:

  | Enunciado | Estado | Situación |
  |---|---|---|
  | solicitado | `BUSCANDO` | hecho |
  | asignado | `ASIGNADO` | hecho |
  | chofer en camino | `EN_CAMINO` | falta |
  | en curso | `EN_CURSO` | falta |
  | finalizado | `COMPLETADA` | hecho (hoy por `liberarChofer`) |
  | cancelado por pasajero | `CANCELADO_PASAJERO` | hecho |
  | cancelado por chofer | `CANCELADO_CHOFER` | falta |
  | sin choferes disponibles | `SIN_CHOFERES` | hecho |

- Finalizar o cancelar libera al chofer **en la misma transacción** (borra su fila de `driver_active_assignment`).
- La cancelación del operador exige motivo. El enunciado no le da estado propio: se decide en `modelo.md` (propuesta: `CANCELADO_OPERADOR`, como extensión documentada).
- Mecanismo de asignación, sin cambios: `FOR UPDATE` de la solicitud, después la reserva única del chofer, siempre en ese orden.
- Un test por cada transición válida y por cada inválida.
- Historial por pasajero y por chofer, y panel del operador con viajes en curso. El panel lleva una **búsqueda por texto**, que es donde va el test de inyección SQL.
- Candidatos: el puerto `BuscadorCandidatos` pasa de la lista fija a un adaptador HTTP contra location, con timeout. El resultado se filtra en dispatch por disponibilidad, zona del origen y flotas habilitadas (sección 2).

### 3.2 location — tarea pesada (6.6) y búsqueda geográfica (6.4)

- **Ingenua** (`UBICACION_ESTRATEGIA=ingenua`): un `INSERT` por ping, y la búsqueda trae todos los choferes y calcula haversine en JavaScript, de forma sincrónica.
- **Final** (`optimizada`, cambia solo en `composicion.ts`):
  - posición vigente en Redis `GEOADD`, con vencimiento para no ofrecer choferes fantasma;
  - búsqueda con `GEOSEARCH`;
  - historial fuera del pedido HTTP: cola en Redis y escritura en lotes.
  - De las cuatro estrategias de 3.3 es la **cola**, más un índice geográfico. Va en el ADR 0005.
- El ADR 0008 compara Redis GEO, PostGIS y geohash (6.4 pide al menos dos opciones con su costo).
- Retención: puntos crudos solo durante el viaje, conservados 30 días; pings de choferes sin viaje, descartados a las 24 h.
- Seguimiento: location publica cada posición en un canal de Redis por chofer. dispatch es quien sabe qué viaje tiene cada chofer, así que la regla de privacidad se aplica ahí: la posición del chofer solo la ve su pasajero actual, y la del pasajero solo su chofer asignado. Con test.
- `GET /interno/candidatos` solo acepta el token de servicio y no se publica por nginx.
- Tiempo declarado hasta la asignación bajo carga: lo fija el grupo **antes** de medir y va como hipótesis.

### 3.3 dispatch · flotas — variante G

- Choferes con vehículo y habilitación que otorga el admin. Disponible / no disponible.
- Flotas con `admin_flota`. El `fleetId` sale del token y se filtra **en el caso de uso**. Pedir algo de otra flota devuelve 404, con test.
- Zonas operativas: polígonos en PostGIS. Se resuelve la zona del origen una vez por solicitud y se ofrece solo a choferes de flotas con esa zona habilitada.
- **Carrera G:** `UPDATE fleets SET active_count = active_count + 1 WHERE id = $1 AND active_count < max_active RETURNING ...`, más `CHECK (active_count <= max_active)`. Test: 50 activaciones simultáneas con límite 10 dejan exactamente 10.
- Reporte por flota: choferes activos, viajes y facturación.

### 3.4 dispatch · tarifas

- Una sola función para la estimación y la tarifa final, en **centavos enteros**. Se guarda por qué difieren.
- Tests de borde: distancia cero y viaje que supera el máximo.
- Cobro simulado detrás de un puerto de pagos, idempotente, que **falla cerrado**.
- Puerto de mapas (distancia y tiempo) con adaptador simulado y adaptador falso.

### 3.5 Transversales

- **Idempotency-Key** en todo lo que crea, cobra o dispara un efecto (registro, solicitud, aceptación, cancelación, finalización, cobro, activación de chofer):
  - `SET NX` en Redis mientras el pedido está en vuelo; el duplicado concurrente recibe 409;
  - registro en Postgres **en la misma transacción que el efecto**, con hash del cuerpo y la respuesta;
  - el reintento recibe la respuesta guardada; la misma clave con otro cuerpo, 422.
  - El middleware va en `platform`; cada servicio guarda los registros en su propia base.
  - Hoy no existe en ningún endpoint.
- **Tiempo real por SSE**, en dispatch:
  - un relay lee el `outbox` y publica en Redis Pub/Sub; el endpoint SSE se suscribe solo a los viajes del usuario;
  - mientras el viaje está activo, el endpoint se suscribe también al canal de posición del chofer asignado, que publica location;
  - al reconectar, el cliente pide el estado actual (`GET /viajes/:id`) y se vuelve a suscribir con `Last-Event-ID`.
- **Inventario de carreras** (bloque 6, punto 1), en un ADR: aceptar contra aceptar, aceptar contra cancelar, chofer con dos viajes, pasajero con dos solicitudes, vencimiento contra aceptación, activación de choferes, email duplicado en el registro, clave de idempotencia duplicada y doble finalización con doble cobro.

## 4. Requisitos de ProgIV: estado al 13/11

✅ hecho · 🟡 parcial · ⬜ falta. El CI está en verde en `main`. Hay 188 tests: 63 de dispatch y 125 de identity.

| Requisito | Estado | Qué falta |
|---|---|---|
| **B1** Arranque reproducible | 🟡 | La secuencia de 2.4 **hoy falla**: `.env.example` trae vacía la clave RS256 y hay que migrar a mano. Faltan `npm run setup`, `dev` y `start` en la raíz. `setup` migra las tres bases, genera la clave si no existe y tiene que andar en Windows y Linux (script de Node, no bash) |
| **B2** Hexagonal | ✅ | Mantenerlo en location y en los módulos nuevos de dispatch. Puertos con doble adaptador: mapas, pagos, notificador, publicador de eventos |
| **B3** Configuración y ciclo de vida | ✅ | Preparar la demo de SIGTERM con un pedido lento |
| **B4** Errores y logs | 🟡 | No hay **log por pedido** (método, ruta, estado, duración): hoy solo se loguean los errores, y no se puede relacionar pedido y error por `requestId` |
| **B5** Autenticación | ✅ | argon2id con costo declarado, RS256 |
| **B5** Autorización por recurso | 🟡 | Hecha y testeada en viajes. Falta en flotas, location e historial |
| **B5** Tres roles con tabla en el README | 🟡 | Hay cinco roles en código; falta la tabla |
| **B5** Validación con esquema | 🟡 | Cuerpo, parámetros y query sí. Falta validar **encabezados** (`Idempotency-Key`) |
| **B5** Prototype pollution | 🟡 | Solo se prueba `__proto__` en la raíz. Falta `constructor.prototype` y posiciones anidadas |
| **B5** Inyección SQL | 🟡 | Consultas parametrizadas sí. Falta el test con una carga típica en un campo de búsqueda |
| **B5** Límite de tasa | 🟡 | Solo en login. Falta en solicitud de viaje y ubicación, con 429 y encabezados |
| **B5** Helmet y CORS | ⬜ | Estaban pensados para el gateway: van en `crearApp` de `platform`, así los heredan los tres servicios. Detrás de nginx el frontend queda en el mismo origen |
| **B5** `npm audit` | ✅ | En el CI |
| **B6** ADR de carreras + test de 50 | ✅ | Falta el inventario completo (3.5) |
| **B6** Idempotencia | ⬜ | 3.5 |
| **B7** Tarea pesada, dos versiones, medida | ⬜ | 3.2. Es lo que se muestra en el Control 3 |
| **B8** Tres niveles de tests, un comando | ✅ | Sostenerlo |
| **6.2** Alcance funcional | 🟡 | Hecho: registro, login, solicitud, ofertas. Falta: vehículo y habilitación, disponibilidad, ubicación, estimación, estados completos, seguimiento, tarifa y cobro, historial, panel |
| **6.3** ADR + 3 tests | ✅ | — |
| **6.4** Búsqueda, retención, privacidad | ⬜ | 3.2 |
| **6.5** Tarifa | ⬜ | 3.4 |
| **6.5** Oferta con vencimiento | ✅ | Barrido cada 2 s, TTL de 15 s |
| **6.5** Tiempo real | ⬜ | 3.5 |
| **6.6** Simulador de 500 choferes y mediciones | ⬜ | 3.2 y 5.5 |
| **6.7 G** Flotas y zonas | ⬜ | 3.3 |
| **7.1** Seis ADR o más | 🟡 | Solo el 0004, y con el formato incompleto |
| **7.2** `docs/mediciones.md` | ⬜ | Cubre la tarea pesada **y también la carrera principal** |
| **7.3** Historial de Git | 🟡 | **Maxi todavía no tiene commits.** El PR #1 se mergeó sin revisión |
| **2.5** README, `modelo.md`, `api.md`, `ataque.md` | ⬜ | — |
| **8** Ataque cruzado | ⬜ | Entorno publicado y congelado, usuarios de prueba, bitácora |

## 5. Rúbrica del Integrador: cómo se cumple cada ítem

### 5.1 Tres temas de las exposiciones (15)

La cátedra confirmó que los temas **los elige el grupo, pueden ser cualquiera, y cada tema cuenta por separado**: una fila de la lista con dos temas vale por dos. «Idempotencia y deduplicación», que expusimos nosotros, son dos temas.

Declaramos tres que ProgIV ya obliga a resolver, así no agregan trabajo:

| Tema | Dónde queda en el proyecto | Demostración |
|---|---|---|
| **Idempotencia** (nuestra exposición) | `Idempotency-Key` con la respuesta guardada (3.5) | La misma petición dos veces: un solo efecto y la misma respuesta. La misma clave con otro cuerpo: 422 |
| **Deduplicación** (nuestra exposición) | `SET NX` en Redis para pedidos en vuelo; eventos de SSE con id y `Last-Event-ID` | Veinte pedidos iguales en simultáneo: uno se procesa y el resto se descarta. Reconexión sin eventos repetidos |
| **Condiciones de carrera** («¿cómo impedir que dos procesos asignen el mismo recurso?») | Asignación única (6.3), **ya hecha**, y la carrera G | Test de 50 aceptaciones: 1 gana. Sacar el `FOR UPDATE` y ver cómo falla |

Con el mismo trabajo quedan cubiertos tres más, que sirven de margen:
- **Control de concurrencia**: bloqueo pesimista en la asignación y `UPDATE` condicional en el límite por flota.
- **Redis: caché** de tarifas y zonas, con invalidación al editarlas (HIT, MISS e invalidación).
- **Redis: datos efímeros**: posiciones de choferes en Redis GEO con vencimiento; el chofer que deja de reportar desaparece de la búsqueda.

De reserva, también cubiertos por lo obligatorio:
- **Monolito modular y microservicios**: la decisión de la sección 2 y el ADR 0006.
- **OAuth 2.0/OIDC, JWT y autorización entre servicios**: JWT RS256 verificado por JWKS en dispatch y location, y token de servicio para las rutas internas; no hay OAuth ni OIDC.
- **Docker Compose para un sistema distribuido**: tres servicios, nginx, Postgres y Redis con healthchecks y orden de arranque.
- **API Gateway y reverse proxy**: nginx como punto de entrada único.
- **Publicación/suscripción y eventos**: Redis Pub/Sub entre location y dispatch, y hacia el SSE.
- **Bulkhead, rate limiting y backpressure**: solo tendríamos el rate limiting.
- **Logs, métricas y trazas**: se superpone con el ítem de Grafana Cloud; no conviene contarlo dos veces.

Quedó afuera circuit breaker: ya no hace falta como tema. Los adaptadores de mapas y pagos llevan igual timeout y fallan cerrado (ProgIV 3.7).

### 5.2 Framework frontend (5)

React + Vite + Zustand, mínimo y sin PWA. Pantallas: login; pasajero (estimar, pedir, seguir en vivo, historial); chofer (disponible, ofertas, avanzar estados); operador (viajes en curso, cancelar con motivo); admin de flota (choferes, activar, reporte). Los errores `{error:{code,message,requestId}}` se muestran en un solo componente.

### 5.3 Playwright (10)

En `e2e/`, contra el sistema levantado con Docker Compose y la base sembrada:
1. Login por rol y pantalla vedada a otro rol.
2. Viaje completo con dos contextos de navegador (pasajero y chofer), con el estado cambiando en vivo del lado del pasajero.
3. Oferta que vence y pasa al siguiente chofer.
4. Admin de flota: activar choferes hasta el límite, y no ver otra flota.
5. Manejo de errores: formulario inválido y sesión vencida.

Evidencias: reporte HTML, trazas y capturas como artefactos del CI y en `docs/evidencias/`.

### 5.4 CI y SAST (10)

Jobs: `verificar` (typecheck, lint, tests; ya existe), `e2e` (compose, `setup`, Playwright, sube el reporte), `sast` (Semgrep con reglas de JavaScript, TypeScript, Node y OWASP; sube SARIF) y `npm audit`. Los cuatro son obligatorios para mergear.

La cátedra no pidió una herramienta en particular. Se usa **Semgrep**: corre dentro de GitHub Actions, funciona con el repositorio privado y no depende de una cuenta externa. En clase se vieron Codacy y SonarCloud; cambiar a una de ellas es reemplazar un job. CodeQL queda afuera: en repositorios privados necesita GitHub Advanced Security.

### 5.5 k6 (10)

En `carga/`, corriendo con la imagen `grafana/k6`:
- `choferes.js`: el **simulador propio** de 6.6. 500 usuarios virtuales, un ping cada 2 s, cinco minutos o más.
- `solicitudes.js`: carga sobre la solicitud de viaje con choferes que aceptan; mide p50, p95 y p99, pedidos por segundo y **tiempo hasta la asignación**.
- `estres.js`: rampa hasta encontrar dónde se degrada.
- `carrera.js`: aceptaciones simultáneas, para el informe de la carrera principal.

Cada escenario tiene umbrales, tres corridas de 30 s o más, y los resúmenes van a `docs/mediciones.md`, con hipótesis escrita antes.

El simulador le pega a location directamente, no a través de nginx. Mientras corre, se registra el lag del event loop de **dispatch**: es la evidencia de que separar location protege la asignación.

Dos detalles: el simulador necesita 500 tokens y el límite de login por IP (30 cada 15 minutos) lo bloquearía, así que el seed de carga los emite o se sube el límite en ese entorno. Y `/health` se mide en paralelo, como pide el bloque 7.

### 5.6 Grafana Cloud (10)

- `/metrics` en los tres servicios, desde `platform`, con `prom-client`: latencia por ruta, lag del event loop (`monitorEventLoopDelay`), memoria, y métricas de negocio (solicitudes, asignaciones, ofertas vencidas, tiempo hasta la asignación, pings por segundo).
- **Grafana Alloy** en un perfil de Compose (`--profile obs`) envía métricas y los logs JSON a Grafana Cloud.
- Dashboards: salud de los tres servicios, despacho y tarea pesada. Se exportan como JSON a `observabilidad/`.
- La cátedra solo necesita acceso al repositorio: los dashboards exportados y las capturas en `docs/evidencias/` son la evidencia, y se muestra en vivo en el coloquio.
- Las credenciales van solo en `.env`. **Sin ellas el sistema levanta igual**: lo exigen la secuencia de 2.4 y la defensa sin internet.
- `/metrics` no queda expuesto al grupo atacante.

## 6. Hoja de ruta

**Las fases van por orden, no por fecha.** El cronograma de la cátedra se fue corriendo durante la cursada y puede volver a cambiar, así que este plan no depende de ninguna fecha. La última entrega final informada fue el 02/12/2026 y sirve solo de referencia. Cuando la cátedra fije una fecha, se ve en qué fase estamos y se recorta según el orden del final de esta sección.

### Fase A — «problema difícil»

Es lo que pide el Control 3: carrera principal con su test (ya está) y tarea pesada en dos versiones con la primera medición.

- [x] Confirmar con la cátedra si se exigen microservicios: sí, tres como mínimo.
- [ ] Esqueleto de `services/location` (health, config, composición, base, CI) y Compose sin RabbitMQ y con `location` (Ivan). Es lo primero: destraba a Maxi.
- [ ] `npm run setup`, `dev`, `start` para los tres servicios; secuencia de 2.4 probada en un clon limpio (Ivan).
- [ ] Contrato de `GET /interno/candidatos` en `contracts` y adaptador HTTP con timeout en dispatch (Ivan, Maxi).
- [ ] location en sus dos versiones, con adaptador en memoria primero (Maxi).
- [ ] `carga/choferes.js`, `carga/solicitudes.js`, `/metrics` con el lag y **primera medición** en `docs/mediciones.md` (Maxi).
- [ ] flotas en dispatch: choferes, vehículos, flotas y la carrera G con su test (Agos).
- [ ] ADR 0001, 0002, 0003, 0005 y 0006; 0004 con el formato corregido.

### Fase B — sistema completo y publicado

Al cerrar esta fase el sistema tiene que poder congelarse para el ataque cruzado, cuando la cátedra lo fije.

- [ ] `viajes`: estados completos, historial, panel del operador con búsqueda (Ivan).
- [ ] Idempotency-Key y SSE (Ivan).
- [ ] Zonas, candidatos filtrados por flota y zona, reporte, aislamiento entre flotas (Agos).
- [ ] Seguridad transversal: helmet, CORS, rate limit, encabezados, log por pedido y los tests que faltan del bloque 5 (Agos).
- [ ] `tarifas`, cobro simulado y adaptadores de mapas y pagos con timeout (Maxi).
- [ ] Caché en Redis, retención de ubicaciones y privacidad del seguimiento (Maxi).
- [ ] Frontend mínimo: base y login (Agos), pasajero y operador (Ivan), chofer (Maxi).
- [ ] Contenedor `web` con nginx como punto de entrada único (Ivan).
- [ ] `modelo.md`, `api.md`, tabla de roles, colección de la demo y usuarios de prueba.
- [ ] README y `docs/arquitectura.md` al día: tecnologías usadas y para qué, arquitectura, comunicación entre servicios y despliegue. La cátedra evalúa desde el repositorio y quiere ver ahí todo lo que se hizo y se usó.
- [ ] Despliegue accesible para el grupo atacante y tag `congelado`.

### Fase C — rúbrica del Integrador y cierre

- [ ] Playwright y job `e2e` (Agos, Ivan).
- [ ] Job `sast` y corrección de lo que encuentre (Ivan).
- [ ] Grafana Cloud y dashboards; `estres.js` y `carrera.js` (Maxi).
- [ ] Mediciones finales, tres corridas por escenario, con conclusión (Maxi).
- [ ] ADR restantes: 0007 SSE, 0008 búsqueda geográfica, 0009 límite por flota, 0010 idempotencia, 0011 vencimiento de ofertas, 0012 inventario de carreras.
- [ ] Autoevaluación de ProgIV 10.6 completa, clon limpio en otra máquina y tag `entrega-final` (Ivan).

### Ataque cruzado — cuando lo fije la cátedra

Se hace cuando la cátedra lo fije; el entorno publicado no se toca durante esa semana.
- [ ] Bitácora del ataque en `docs/ataque.md`: Agos (autenticación, acceso a recursos ajenos, rate limit), Ivan (carreras e idempotencia), Maxi (validación, montos, operaciones costosas).
- [ ] Hallazgos recibidos: causa raíz, commit y un test que falla antes y pasa después (el dueño del módulo).

Si cae antes de terminar la Fase C, desplaza ese trabajo y se recorta según el orden de abajo.

### Defensa de ProgIV y coloquio del Integrador

Cada dueño le explica su parte a los otros dos. Ensayar los cuatro tipos de pregunta de ProgIV 9.2 (predicción, diagnóstico, modificación en vivo, justificación de un ADR) y, para el Integrador, interpretar en vivo el pipeline, k6 y los dashboards.

**Si falta tiempo, en este orden:** bloques comunes de ProgIV (un bloque ausente limita la nota a 5) → 6.3, 6.6 y variante G → ataque cruzado → k6, CI con SAST y Playwright → Grafana Cloud → frontend más allá de lo que Playwright necesita.

## 7. Verificación

1. Clon limpio en otra máquina: `cp .env.example .env`, `docker compose up -d`, `npm run setup`, `npm test`, `npm start` y la colección de la demo.
2. Borrar una variable: el proceso sale con código distinto de cero y nombra la variable.
3. SIGTERM durante un pedido lento: el log muestra que terminó antes de salir.
4. Un error provocado: respuesta sin detalles internos, y pedido y error encontrados por `requestId`.
5. Tests de concurrencia: 50 aceptaciones dejan 1 asignación; cancelar contra aceptar; 50 activaciones con límite 10 dejan 10. Cada uno **falla si se saca la protección**.
6. La misma `Idempotency-Key` dos veces: un solo efecto.
7. `docker compose ps` muestra `identity`, `dispatch` y `location` en contenedores separados. Con location detenido, la solicitud de viaje devuelve 503 y el login sigue andando.
8. Demo de 6.8: ciclo completo con seguimiento, oferta que vence con el chofer desconectado, ubicación ajena rechazada, 500 choferes con medición antes y después, variante G con su carrera.
9. `npm run test:e2e` en verde, y el pipeline completo en verde en GitHub.
10. k6 en versión ingenua y optimizada, con los números en `docs/mediciones.md`.
11. Dashboards de Grafana Cloud mostrando una corrida de k6.

## 8. Preguntas para la cátedra

Están en [docs/consultas-catedra.md](docs/consultas-catedra.md), con lo que asumimos mientras tanto y el lugar para anotar cada respuesta. Casi todas están respondidas. Queda abierto solo contra qué grupo es el ataque cruzado, y no frena trabajo.
