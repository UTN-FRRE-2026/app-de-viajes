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
| La tabla de 6 tiene 8 grupos, pero 6.7 define una variante I para un «grupo 9». | El emparejamiento del enunciado no corre: la modalidad del ataque todavía no está definida (ver «Ataque cruzado» en la sección 6). |
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
- **Si identity se cae,** dispatch y location siguen verificando tokens con las claves que ya bajaron, pero solo mientras sigan en la caché de `jose` (unos 10 minutos por defecto). Después, los tokens dejan de verificarse hasta que identity vuelva.
- **`fleetId`:** identity lo guarda sin clave foránea (la flota vive en dispatch) y lo pone en el token del `admin_flota`. dispatch valida que la flota exista cuando se usa.

### Punto de entrada

Un contenedor **web** (nginx) sirve el frontend y hace de reverse proxy: `/api/identity/`, `/api/viajes/` y `/api/ubicacion/`. Es el único puerto que se publica a los grupos atacantes.
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
| ADR 0004 | Formato corregido | Tiene «quiénes participaron» y «qué nos haría cambiar de decisión»; sin menciones a M5 |
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
  | chofer en camino | `EN_CAMINO` | hecho: `POST /solicitudes/:id/en-camino` |
  | en curso | `EN_CURSO` | hecho: `POST /solicitudes/:id/iniciar` |
  | finalizado | `COMPLETADA` | hecho: `POST /solicitudes/:id/finalizar` |
  | cancelado por pasajero | `CANCELADO_PASAJERO` | hecho |
  | cancelado por chofer | `CANCELADO_CHOFER` | hecho |
  | (extensión) cancelado por operador | `CANCELADO_OPERADOR` | hecho, con motivo obligatorio |
  | sin choferes disponibles | `SIN_CHOFERES` | hecho |

- Las tres acciones del chofer las hace solo el chofer asignado (otro chofer recibe 404). `POST /solicitudes/:id/cancelar` sirve para los tres roles: el pasajero cancela hasta `EN_CAMINO`; el chofer, en `ASIGNADO` o `EN_CAMINO`; el operador (y el admin), en cualquier estado activo, con `motivo` obligatorio (sin motivo, 422). Saltear un paso o repetirlo da 409 `TRANSICION_INVALIDA`.
- Finalizar o cancelar libera al chofer **en la misma transacción** (borra su fila de `driver_active_assignment`). El chofer queda reservado durante `EN_CAMINO` y `EN_CURSO`, y el pasajero no puede pedir otro viaje mientras el suyo está activo.
- La cancelación del operador queda como `CANCELADO_OPERADOR`, una extensión documentada del enunciado; falta explicarla en `modelo.md`. La base exige el motivo con un `CHECK`.
- Mecanismo, sin cambios: `FOR UPDATE` de la solicitud, después la reserva única del chofer, siempre en ese orden. Las acciones del chofer y la cancelación toman el mismo lock.
- Tests: la matriz de 9 estados × 8 acciones de la entidad (cada transición válida y cada inválida), el ciclo completo por HTTP contra Postgres y dos carreras nuevas: 20 finalizaciones simultáneas (1 gana) y finalizar contra la cancelación del operador. Las dos fallan si se saca el `FOR UPDATE`.
- Historial por pasajero y por chofer, y panel del operador con viajes en curso. El panel lleva una **búsqueda por texto**, que es donde va el test de inyección SQL. Hecho:
  - `GET /historial` (pasajero o chofer): sus viajes, del más nuevo al más viejo, con fecha. El usuario sale del token; la query solo acepta `limite` (1 a 50) y `desde`.
  - `GET /panel/viajes` (operador o admin): por defecto los viajes activos; filtra por `estado` y busca con `q` en el id del viaje, del pasajero y del chofer, y en el motivo de cancelación, sin distinguir mayúsculas.
  - La búsqueda va como parámetro de la consulta y `%` y `_` se buscan como texto. Tests con siete cargas de inyección; fallan si el texto se concatena al SQL o si no se escapan los comodines (comprobado).
  - Paginación por desplazamiento: la respuesta trae `siguiente`. Índices nuevos por chofer y por estado y fecha.
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
- Seguimiento: location publica cada posición en un canal de Redis por chofer (**hecho**: canal `<prefijo>posicion:<choferId>`, contrato `PosicionChoferPublicada`, en orden por timestamp y sin anunciar pings vencidos; ver `docs/location.md`). dispatch es quien sabe qué viaje tiene cada chofer, así que la regla de privacidad se aplica ahí: la posición del chofer solo la ve su pasajero actual, y la del pasajero solo su chofer asignado. Con test. **Hecho también en location:** la posición del pasajero (`POST /ubicaciones/pasajero`, canal `<prefijo>posicion-pasajero:<pasajeroId>`, contrato `PosicionPasajeroPublicada`), efímera y fuera de la búsqueda de candidatos. **Hecho en dispatch:** el stream del chofer la recibe (`PassengerLocationUpdated`), solo la del pasajero de su viaje activo.
- `GET /interno/candidatos` solo acepta el token de servicio y no se publica por nginx.
- Tiempo declarado hasta la asignación bajo carga: lo fija el grupo **antes** de medir y va como hipótesis.

### 3.3 dispatch · flotas — variante G

- Choferes con vehículo y habilitación que otorga el admin. Disponible / no disponible.
- Flotas con `admin_flota`. El `fleetId` sale del token y se filtra **en el caso de uso**. Pedir algo de otra flota devuelve 404, con test.
- Zonas operativas: polígonos en PostGIS. Se resuelve la zona del origen una vez por solicitud y se ofrece solo a choferes de flotas con esa zona habilitada.
- **Carrera G:** `UPDATE fleets SET active_count = active_count + 1 WHERE id = $1 AND active_count < max_active RETURNING ...`, más `CHECK (active_count <= max_active)`. Test: 50 activaciones simultáneas con límite 10 dejan exactamente 10.
- Reporte por flota: choferes activos, viajes y facturación.
- **Hecho (PR 1 de flotas, Agostina):** flotas con límite (`PUT /admin/flotas/:id`), alta de choferes con vehículo (la cuenta se verifica en identity con `GET /interno/usuarios/:id`), habilitación por el admin, activación por el admin_flota con la carrera G, disponibilidad del chofer y aislamiento por `fleetId` en el caso de uso. Test de 50 activaciones contra límite 10 contra Postgres, con mutaciones comprobadas. Detalle en `docs/flotas.md`. **Falta:** zonas (PostGIS), filtro de candidatos por flota y zona, y el reporte.

### 3.4 dispatch · tarifas

- Una sola función para la estimación y la tarifa final, en **centavos enteros**. Se guarda por qué difieren.
- Tests de borde: distancia cero y viaje que supera el máximo.
- Cobro simulado detrás de un puerto de pagos, idempotente, que **falla cerrado**.
- Puerto de mapas (distancia y tiempo) con adaptador simulado y adaptador falso.
- **Hecho (PR 1 de tarifas):** la función de cálculo, el puerto de mapas con timeout y falla cerrado, y `GET /tarifas/estimacion`. Fórmula, redondeo, contrato y decisiones en [docs/tarifas.md](docs/tarifas.md).
- **Hecho (PR 2 de tarifas, Agostina):** la configuración por el admin. Tarifa global versionada en Postgres con auditoría, `GET` y `PUT /admin/tarifas` (el `PUT` con Idempotency-Key), los `TARIFA_*` como semilla, y caché en Redis por versión. El alcance por flota o zona sigue como decisión del equipo.
- **Hecho en el PR 3:** la estimación guardada al crear la solicitud (y fuera de rango, 422), la tarifa final con la versión de la estimación y la duración real, por qué difieren, y el cobro: automático por el barrido o con `POST /solicitudes/:id/cobrar`, sin doble cobro y con falla cerrado. Detalle en `docs/tarifas.md`.

### 3.5 Transversales

- **Idempotency-Key** en todo lo que crea, cobra o dispara un efecto (registro, solicitud, aceptación, cancelación, finalización, cobro, activación de chofer):
  - `SET NX` en Redis mientras el pedido está en vuelo; el duplicado concurrente recibe 409;
  - registro en Postgres **en la misma transacción que el efecto**, con hash del cuerpo y la respuesta;
  - el reintento recibe la respuesta guardada; la misma clave con otro cuerpo, 422.
  - El middleware va en `platform`; cada servicio guarda los registros en su propia base.
  - **Hecho en dispatch:** los seis `POST` con efecto (crear, aceptar, en camino, iniciar, finalizar y cancelar) exigen el encabezado; sin él, 400. También `POST /solicitudes/:id/cobrar`. También las rutas de flotas, con la activación de chofer (Agos), y el registro de identity, con la clave por email y sin la contraseña en la huella. Cada uno aplica `idempotente()` en su ruta.
    - El middleware (`packages/platform/src/idempotencia.ts`) valida la clave con un esquema (16 a 128 letras, números, `-` o `_`), la asocia al usuario del token y calcula la huella: método, ruta y cuerpo ya validado, con las claves ordenadas.
    - El registro (`idempotency_keys`) lo escribe el adaptador de Postgres de dispatch al final de la transacción del caso de uso, con el resultado como respuesta. Se guarda como `json`, no `jsonb`, para devolver el reintento byte a byte. Los errores no se guardan: no tuvieron efecto, así que el reintento se vuelve a procesar.
    - El reintento sale con `Idempotent-Replayed: true`. Si Redis no responde: 503, falla cerrado.
    - Si el cerrojo vence con el pedido en curso (30 s, `IDEMPOTENCIA_EN_VUELO_SEGUNDOS`), la clave primaria del registro impide el segundo efecto. Lo que agrega el cerrojo es que los duplicados no lleguen al caso de uso: sin él, igual repetirían lo que pasa fuera de la base (la búsqueda en location, o el cobro al proveedor).
    - Tests contra Postgres y Redis (`tests/seguridad/idempotencia.test.ts` y `tests/concurrencia/idempotencia.test.ts`). Comprobado que fallan si se saca el cerrojo, el registro en la transacción o la comparación de la huella.
    - Las respuestas se guardan como mínimo 24 h (`IDEMPOTENCIA_RETENCION_HORAS`). Cada minuto, una purga borra las vencidas por lotes, con `FOR UPDATE SKIP LOCKED` para que varias instancias no se esperen (`tests/integracion/purga-idempotencia.test.ts`). Pasada la retención, la misma clave vuelve a ejecutar el pedido.
    - Decisión, alternativas y cómo se verifica: [ADR 0010](docs/adr/0010-idempotencia.md).
- **Tiempo real por SSE**, en dispatch:
  - un relay lee el `outbox` y publica en Redis Pub/Sub; el endpoint SSE se suscribe solo a los viajes del usuario;
  - mientras el viaje está activo, el endpoint del pasajero se suscribe también al canal de posición del chofer asignado, y el del chofer al del pasajero, que publica location;
  - al reconectar, el cliente pide el estado actual (`GET /solicitudes/:id`) y se vuelve a suscribir con `Last-Event-ID`.
  - **Hecho** (`GET /eventos`, detalle en `docs/eventos.md`), también las posiciones en vivo: el stream del pasajero sigue al chofer de su viaje activo (`DriverLocationUpdated`) y el del chofer al pasajero (`PassengerLocationUpdated`), con una suscripción por canal y por instancia, y nadie más las ve. Relay con `FOR UPDATE SKIP LOCKED`, un canal por usuario, reposición desde el outbox, descarte de repetidos, 3 streams por usuario (429), cierre al vencer el token y al apagar. Comprobado que los tests fallan sin el `SKIP LOCKED`, sin el filtro por destinatario, sin el descarte de repetidos y sin la espera durante la reposición. Decisión y alternativas: [ADR 0007](docs/adr/0007-tiempo-real-sse.md).
- **Inventario de carreras** (bloque 6, punto 1), en un ADR: aceptar contra aceptar, aceptar contra cancelar, chofer con dos viajes, pasajero con dos solicitudes, vencimiento contra aceptación, activación de choferes, email duplicado en el registro, clave de idempotencia duplicada y doble finalización con doble cobro.

## 4. Requisitos de ProgIV: estado al 22/11

✅ hecho · 🟡 parcial · ⬜ falta. El CI está en verde en `main`. Hay 830 tests: 518 de dispatch, 174 de identity y 138 de location.

| Requisito | Estado | Qué falta |
|---|---|---|
| **B1** Arranque reproducible | ✅ | `npm run setup` (script de Node: `.env`, clave RS256, Postgres y Redis, bases que falten, migraciones y seed), `npm run dev` y `npm start`. Probado en un clon limpio con un volumen vacío, en Linux y en Windows |
| **B2** Hexagonal | ✅ | Puertos con doble adaptador en los tres servicios: mapas, pagos, candidatos (location o lista fija), directorio de identity, estrategia de ubicaciones (ingenua u optimizada), bus de eventos y posiciones (Redis o memoria) |
| **B3** Configuración y ciclo de vida | ✅ | Configuración validada con Zod al arrancar y apagado ordenado (corta los streams SSE, espera los barridos). Falta preparar la demo de SIGTERM con un pedido lento |
| **B4** Errores y logs | 🟡 | No hay **log por pedido** (método, ruta, estado, duración): hoy solo se loguean los errores, y no se puede relacionar pedido y error por `requestId` |
| **B5** Autenticación | ✅ | argon2id con costo declarado, RS256, refresh con rotación y detección de reuso |
| **B5** Autorización por recurso | ✅ | En el caso de uso: viajes, historial, cobro, flotas (`fleetId` del token, 404 a otra flota) y el stream SSE (cada uno recibe solo lo suyo, también las posiciones en vivo: la del chofer solo su pasajero, y la del pasajero solo su chofer). En location, la posición sale del token: nadie informa la de otro |
| **B5** Tres roles con tabla en el README | 🟡 | Hay cinco roles en código; falta la tabla |
| **B5** Validación con esquema | ✅ | Cuerpo, parámetros, query y encabezados (`Idempotency-Key`, `Last-Event-ID`), con test de cada formato inválido |
| **B5** Prototype pollution | 🟡 | Solo se prueba `__proto__` en la raíz. Falta `constructor.prototype` y posiciones anidadas |
| **B5** Inyección SQL | ✅ | Consultas parametrizadas y tests con cargas típicas en la búsqueda del panel (`GET /panel/viajes?q=`) |
| **B5** Límite de tasa | 🟡 | En login, y 3 streams SSE por usuario. Falta en solicitud de viaje y ubicación, con 429 y encabezados |
| **B5** Helmet, CSP y CORS | ✅ | Hecho: helmet en `crearApp` de `platform`, con una CSP que lo niega todo (`default-src 'none'`) en la API de los tres servicios, con test en cada uno; y la CSP de la página en el nginx del contenedor `web` (`npm run web:probar`, [docs/web.md](docs/web.md)). El frontend y la API quedan en el mismo origen: no hace falta CORS. Playwright comprueba en cada pantalla que no hay violaciones de la CSP ([docs/ci.md](docs/ci.md)) |
| **B5** `npm audit` | ✅ | En el CI |
| **B6** ADR de carreras + test de 50 | ✅ | Falta el inventario completo (3.5) |
| **B6** Idempotencia | ✅ | En los `POST` de dispatch, el `PUT` de tarifas, el cobro (que además usa el id del cobro como clave con el proveedor), las rutas de flotas con la activación de choferes y el registro de identity. Las respuestas se guardan 24 h y una purga borra las vencidas, en los dos servicios (3.5, [ADR 0010](docs/adr/0010-idempotencia.md)) |
| **B7** Tarea pesada, dos versiones, medida | ✅ | location: ingenua (Postgres) frente a optimizada (Redis GEO e historial en lotes), con hipótesis escrita antes y 3 corridas de k6 por versión (`docs/mediciones.md`). Es lo que se muestra en el Control 3 |
| **B8** Tres niveles de tests, un comando | ✅ | Sostenerlo |
| **6.2** Alcance funcional | ✅ | Hecho en el backend: registro, login, solicitud, ofertas, ubicación, estados completos del viaje, estimación, tarifa final y cobro, historial, panel, flotas y seguimiento en vivo. En el frontend, las pantallas de los cuatro roles: pasajero, chofer, operador y admin de flota ([docs/web.md](docs/web.md)). Los flujos principales, recorridos con Playwright (e2e/) |
| **6.3** ADR + 3 tests | ✅ | — |
| **6.4** Búsqueda, retención, privacidad | 🟡 | Hecho: la búsqueda de candidatos con vigencia de 30 s (los choferes que dejan de reportar no aparecen) y la privacidad de la posición (la del chofer solo la ve el pasajero del viaje, y la del pasajero solo su chofer). Falta la retención del historial de ubicaciones |
| **6.5** Tarifa | ✅ | Cálculo, estimación, configuración por el admin, tarifa final con por qué difiere, y cobro (3.4) |
| **6.5** Oferta con vencimiento | ✅ | Barrido cada 2 s, TTL de 15 s |
| **6.5** Tiempo real | ✅ | SSE con los eventos del viaje, reconexión con `Last-Event-ID` y las posiciones en vivo: la del chofer para su pasajero, y la del pasajero para su chofer (3.5) |
| **6.6** Simulador de 500 choferes y mediciones | ✅ | 500 choferes con k6 contra location, en un entorno de carga aislado (`carga/`). De punta a punta con dispatch (24/11): viajes en paralelo con el filtro real, ingenua frente a optimizada, y rampa de estrés, con las hipótesis commiteadas antes y 3 corridas por escenario (`docs/mediciones.md`) |
| **6.7 G** Flotas y zonas | 🟡 | Hecho: flotas, choferes con vehículo, habilitación, disponibilidad, límite de activos con la carrera G (test de 50 contra 10) y aislamiento entre flotas (3.3, `docs/flotas.md`), el panel `/flota` (cupo, alta, activar y desactivar), zonas en PostGIS, filtro de candidatos por flota y zona con lotes crecientes, y la revalidación al aceptar con la flota guardada en el viaje (PR 2). Falta: los viajes y la facturación del reporte |
| **7.1** Seis ADR o más | ✅ | Hay seis: 0001, 0004, 0005, 0006, 0007 (SSE) y 0010 (idempotencia). Faltan 0002, 0003, 0008, 0009, 0011 y 0012 |
| **7.2** `docs/mediciones.md` | ✅ | Cubre la tarea pesada, la carrera principal (6.3), y las solicitudes bajo carga y estrés con el tiempo hasta la asignación |
| **7.3** Historial de Git | 🟡 | Los tres tienen commits y cada PR pasa por revisión de otro. El PR #1 se mergeó sin revisión |
| **2.5** README, `modelo.md`, `api.md`, `ataque.md` | 🟡 | Hay README. Faltan `modelo.md`, `api.md` y `ataque.md` |
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

**Hecho:** los cinco, en `e2e/` con Playwright 1.64.1, más la comprobación de que ninguna página tiene violaciones de la CSP. Cómo correrlos y las decisiones: [docs/ci.md](docs/ci.md#e2e-playwright-e2e).

### 5.4 CI y SAST (10)

**Hecho** ([docs/ci.md](docs/ci.md)). Jobs: `verificar` (typecheck, lint, tests; ya existe), `e2e` (compose, `setup`, Playwright, sube el reporte), `sast` (Semgrep con reglas de JavaScript, TypeScript, Node y OWASP; sube SARIF) y `npm audit`. Los cuatro son obligatorios para mergear.

La cátedra no pidió una herramienta en particular. Se usa **Semgrep**: corre dentro de GitHub Actions, funciona con el repositorio privado y no depende de una cuenta externa. En clase se vieron Codacy y SonarCloud; cambiar a una de ellas es reemplazar un job. CodeQL queda afuera: en repositorios privados necesita GitHub Advanced Security.

### 5.5 k6 (10)

En `carga/`, corriendo con la imagen `grafana/k6`:
- `choferes.js`: el **simulador propio** de 6.6. 500 usuarios virtuales, un ping cada 2 s, cinco minutos o más.
- `solicitudes.js`: carga sobre la solicitud de viaje con choferes que aceptan; mide p50, p95 y p99, pedidos por segundo y **tiempo hasta la asignación**. Es Node y no k6, porque pasajeros y choferes se enteran por SSE.
- `estres.js`: rampa hasta encontrar dónde se degrada.
- `carrera.js`: aceptaciones simultáneas, para el informe de la carrera principal.

Cada escenario tiene umbrales, tres corridas de 30 s o más, y los resúmenes van a `docs/mediciones.md`, con hipótesis escrita antes.

El simulador le pega a location directamente, no a través de nginx. Mientras corre, se registra el lag del event loop de **dispatch**: es la evidencia de que separar location protege la asignación.

Dos detalles: el simulador necesita 500 tokens y el límite de login por IP (30 cada 15 minutos) lo bloquearía, así que el seed de carga los emite o se sube el límite en ese entorno. Y `/health` se mide en paralelo, como pide el bloque 7.

### 5.6 Grafana Cloud (10)

- `/metrics` en los tres servicios, desde `platform`, con `@prometheus-io/client` (antes `prom-client`, que quedó deprecado): latencia por ruta, lag del event loop (`monitorEventLoopDelay`), memoria, y métricas de negocio (solicitudes, asignaciones, ofertas vencidas, tiempo hasta la asignación, pings por segundo). **Hecho**, salvo pings por segundo. Se protege con `Authorization: Bearer <METRICAS_TOKEN>`, que Alloy manda con `bearer_token`. El tiempo hasta la asignación va desde antes de buscar candidatos hasta el COMMIT de la aceptación.
- **Grafana Alloy** en un perfil de Compose (`--profile obs`) envía métricas y los logs JSON a Grafana Cloud.
- Dashboards: salud de los tres servicios, despacho y tarea pesada. Se exportan como JSON a `observabilidad/`.
- La cátedra solo necesita acceso al repositorio: los dashboards exportados y las capturas en `docs/evidencias/` son la evidencia, y se muestra en vivo en el coloquio.
- Las credenciales van solo en `.env`. **Sin ellas el sistema levanta igual**: lo exigen la secuencia de 2.4 y la defensa sin internet.
- `/metrics` no queda expuesto a los grupos atacantes.

## 6. Hoja de ruta

**Las fases van por orden, no por fecha.** El cronograma de la cátedra se fue corriendo durante la cursada y puede volver a cambiar, así que este plan no depende de ninguna fecha. La última entrega final informada fue el 02/12/2026 y sirve solo de referencia. Cuando la cátedra fije una fecha, se ve en qué fase estamos y se recorta según el orden del final de esta sección.

### Fase A — «problema difícil»

Es lo que pide el Control 3: carrera principal con su test (ya está) y tarea pesada en dos versiones con la primera medición.

- [x] Confirmar con la cátedra si se exigen microservicios: sí, tres como mínimo.
- [x] Esqueleto de `services/location` (health, config, composición, base, CI) y Compose sin RabbitMQ y con `location`. El esqueleto lo hizo Agos (#7); el Compose sin RabbitMQ, Ivan.
- [x] `npm run setup`, `dev`, `start` para los tres servicios; secuencia probada en un clon limpio, en Linux y en Windows (Ivan).
- [x] Contrato de `GET /interno/candidatos` en `contracts` y adaptador HTTP con timeout en dispatch (Ivan, Maxi).
- [x] location en sus dos versiones, con adaptador en memoria primero (Agos #7, Maxi #8).
- [x] `carga/choferes.js`, `carga/solicitudes.js`, `/metrics` con el lag y **primera medición** en `docs/mediciones.md` (Maxi). Hecho: `carga/ubicaciones.js`, la primera medición y `/metrics` en los tres servicios desde `platform`, con el tiempo hasta la asignación en dispatch. Hecho (24/11): `carga/solicitudes.js` con 20 pasajeros y 50 choferes en paralelo, con el filtro real de flotas y zonas, 3 corridas por estrategia y el lag por ventana (`event_loop_lag_seconds`) (`docs/mediciones.md`). El simulador de 500 choferes es `carga/ubicaciones.js`.
- [x] flotas en dispatch: choferes, vehículos, flotas y la carrera G con su test (Agos, PR 1 de flotas).
- [ ] ADR 0001, 0002, 0003, 0005 y 0006; 0004 con el formato corregido. Hechos: 0001, 0004, 0005 y 0006. Faltan 0002 y 0003 (Agos).

### Fase B — sistema completo y publicado

Al cerrar esta fase el sistema tiene que poder congelarse para el ataque cruzado, cuando la cátedra lo fije.

- [x] `viajes`: estados completos, historial, panel del operador con búsqueda (Ivan).
- [x] Idempotency-Key en `platform` y en los `POST` de dispatch (Ivan).
- [x] SSE con los eventos del viaje y reconexión (Ivan), y las posiciones en vivo: location las publica (Maxi) y dispatch reenvía la del chofer al pasajero y la del pasajero al chofer (Ivan).
- [ ] Zonas, candidatos filtrados por flota y zona, reporte, aislamiento entre flotas (Agos). Hecho: el aislamiento entre flotas (PR 1 de flotas), los activos del reporte (el cupo, en el panel), y las zonas en PostGIS, el filtro de candidatos y `fleet_id` guardado al aceptar (PR 2). Falta: los viajes y la facturación del reporte (`docs/flotas.md`).
- [ ] Seguridad transversal: CORS, rate limit, encabezados, log por pedido y los tests que faltan del bloque 5 (Agos).
- [x] `tarifas`, cobro simulado y adaptadores de mapas y pagos con timeout: cálculo, estimación y mapas con timeout (Maxi); configuración por el admin con caché en Redis (Agostina); tarifa final, cobro y pagos (Ivan).
- [ ] Caché en Redis, retención de ubicaciones y privacidad del seguimiento (Maxi).
- [ ] Frontend mínimo: base y login (Agos), pasajero y operador (Ivan), chofer (Maxi). Hecho: la base y el login (`apps/web`, React + Vite + Zustand, servido por nginx con su CSP; `docs/web.md`), la pantalla del chofer (disponibilidad, ubicación, ofertas por SSE y viaje activo, con `GET /chofer/estado`) y el panel del admin de flota (cupo, lista, alta, activar y desactivar). Falta: pasajero y operador.
- [x] Contenedor `web` con nginx como punto de entrada único (Ivan), con la **CSP de la página** (punto extra que ofreció la cátedra): `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` (las teselas del mapa son lo único de afuera, y solo como imágenes), `/interno/*`, `/metrics` y `/ready` sin publicar, SSE sin buffer y `trust proxy` solo para la IP de nginx ([docs/web.md](docs/web.md)). Falta: servir el build de Vite cuando esté el frontend, y el test en Playwright de que la página carga sin violaciones de CSP en la consola.
- [ ] `modelo.md`, `api.md`, tabla de roles, colección de la demo y usuarios de prueba.
- [ ] README y `docs/arquitectura.md` al día: tecnologías usadas y para qué, arquitectura, comunicación entre servicios y despliegue. La cátedra evalúa desde el repositorio y quiere ver ahí todo lo que se hizo y se usó.
- [ ] Despliegue accesible para los grupos atacantes y tag `congelado`.

### Fase C — rúbrica del Integrador y cierre

- [x] Playwright y job `e2e` (Ivan): los cinco flujos de 5.3 en `e2e/` ([docs/ci.md](docs/ci.md)).
- [x] Job `sast` y corrección de lo que encuentre (Ivan): Semgrep, 11 hallazgos en la primera pasada, corregidos o justificados en el código ([docs/ci.md](docs/ci.md#sast-semgrep)).
- [ ] Grafana Cloud y dashboards; `estres.js` y `carrera.js` (Maxi). Hecho: `carga/carrera.js` (22/11, una corrida de validación) y `carga/estres.js` con 3 corridas (24/11): se degrada en 16 viajes/s por la espera del commit en el disco mecánico de esta máquina; sin esa espera, sostiene 16 y se satura en 32, por la CPU de dispatch. Falta repetirlo con Docker en un SSD, y Grafana Cloud.
- [ ] Mediciones finales, tres corridas por escenario, con conclusión (Maxi).
- [ ] ADR restantes: 0007 SSE, 0008 búsqueda geográfica, 0009 límite por flota, 0010 idempotencia, 0011 vencimiento de ofertas, 0012 inventario de carreras. Hechos: 0007 y 0010.
- [ ] Autoevaluación de ProgIV 10.6 completa, clon limpio en otra máquina y tag `entrega-final` (Ivan).

### Ataque cruzado — cuando lo fije la cátedra

La cátedra todavía no definió la modalidad. Lo más probable es que **todos los grupos ataquen a uno por vez, rotando**, hasta que todos hayan sido atacados por todos. Nos preparamos para ese caso, que es el más exigente: atacamos a todos los demás grupos y nos atacan todos. El entorno publicado no se toca mientras nos atacan.
- [ ] Guía de ataque reutilizable: la misma lista de pruebas se corre contra cada grupo, con scripts donde se pueda (Ivan, Agos, Maxi).
- [ ] Bitácora del ataque en `docs/ataque.md`, con una sección por grupo atacado: Agos (autenticación, acceso a recursos ajenos, rate limit), Ivan (carreras e idempotencia), Maxi (validación, montos, operaciones costosas).
- [ ] Hallazgos recibidos: causa raíz, commit y un test que falla antes y pasa después (el dueño del módulo).

Si cae antes de terminar la Fase C, desplaza ese trabajo y se recorta según el orden de abajo.

### Defensa de ProgIV y coloquio del Integrador

Cada dueño le explica su parte a los otros dos. Ensayar los cuatro tipos de pregunta de ProgIV 9.2 (predicción, diagnóstico, modificación en vivo, justificación de un ADR) y, para el Integrador, interpretar en vivo el pipeline, k6 y los dashboards.

**Si falta tiempo, en este orden:** bloques comunes de ProgIV (un bloque ausente limita la nota a 5) → 6.3, 6.6 y variante G → ataque cruzado → k6, CI con SAST y Playwright → Grafana Cloud → frontend más allá de lo que Playwright necesita.

## 7. Verificación

1. Clon limpio en otra máquina: `npm install`, `npm run setup`, `npm test`, `npm start` (o `docker compose up -d --build`) y la colección de la demo.
2. Borrar una variable: el proceso sale con código distinto de cero y nombra la variable.
3. SIGTERM durante un pedido lento: el log muestra que terminó antes de salir.
4. Un error provocado: respuesta sin detalles internos, y pedido y error encontrados por `requestId`.
5. Tests de concurrencia: 50 aceptaciones dejan 1 asignación; cancelar contra aceptar; 50 activaciones con límite 10 dejan 10. Cada uno **falla si se saca la protección**.
6. La misma `Idempotency-Key` dos veces: un solo efecto.
7. `docker compose ps` muestra `identity`, `dispatch` y `location` en contenedores separados. Con location detenido, la solicitud de viaje devuelve 503 y el login sigue andando.
8. Demo de 6.8: ciclo completo con seguimiento, oferta que vence con el chofer desconectado, ubicación ajena rechazada, 500 choferes con medición antes y después, variante G con su carrera.
9. `npm run e2e` en verde, y el pipeline completo en verde en GitHub.
10. k6 en versión ingenua y optimizada, con los números en `docs/mediciones.md`.
11. Dashboards de Grafana Cloud mostrando una corrida de k6.

## 8. Preguntas para la cátedra

Están en [docs/consultas-catedra.md](docs/consultas-catedra.md), con lo que asumimos mientras tanto y el lugar para anotar cada respuesta. Casi todas están respondidas. Queda abierta solo la modalidad del ataque cruzado, y no frena trabajo.
