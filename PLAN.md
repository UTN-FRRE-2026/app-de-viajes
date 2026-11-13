# Plan v2 — Plataforma de viajes (Grupo 7 · Variante G: Flotas y zonas operativas)

Reescrito el 13/11/2026. Reemplaza al plan de microservicios del 21/10 (queda en el historial de Git).

> **Pendiente de confirmar con la cátedra** si el Integrador exige microservicios. Las preguntas y lo que asumimos mientras tanto están en [docs/consultas-catedra.md](docs/consultas-catedra.md). Hasta tener esa respuesta, el código sigue como está (dos servicios: `identity` y `dispatch`) y no se consolida.

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

**Se suma:** frontend con framework (antes era opcional), Playwright, SAST en el CI, k6, Grafana Cloud y tres temas de las exposiciones.

### Inconsistencias entre los documentos (cómo las resolvemos)

| Qué dice | Cómo lo tomamos |
|---|---|
| ProgIV 1.4 (y la copia en el Integrador): «el frontend no suma nota». La rúbrica del Integrador le da 5 puntos y Playwright (10) lo necesita. | Se hace un frontend **mínimo**, después del núcleo. |
| ProgIV admite autocannon o k6; el Integrador pide k6. | **k6 para todo**: simulador de choferes, mediciones de 6.6 y escenarios de estrés. |
| El Integrador cita `docs/ataque.md`, «sección 8» y «el cronograma de la sección 10», pero no trae esas secciones. | Siguen vigentes por ProgIV. La única fecha confirmada es la entrega final del 02/12/2026; el resto, **preguntar**. |
| La sección 6 se titula «Comisión 1» y el resto del texto dice que viajes es de la Comisión 2. «17. Artefactos» es la sección 7. | Errores de tipeo. Somos el grupo 7 de la tabla de 6 (Stabile, Jara, Sanchez → variante G). |
| La tabla de 6 tiene 8 grupos, pero 6.7 define una variante I para un «grupo 9». | Si existe el grupo 9, cambia el emparejamiento del ataque (hoy: atacamos al 8, nos ataca el 6). **Preguntar.** |
| El Integrador dice «versión preliminar». | Puede cambiar otra vez: la rúbrica se implementa en capas que no tocan el núcleo. |

## 2. Decisión: monolito modular

**Un solo backend Express** (`services/api`), con módulos internos, **una base Postgres** y Redis. Sin RabbitMQ, sin gateway y sin servicio de tiempo real aparte.

Por qué:
- Ningún enunciado pide ya microservicios. ProgIV pide «un solo sistema», «levantar el servidor» y «un único archivo de composición».
- El problema central (6.3) bloquea viaje y chofer en **una transacción**. Con todo en una base desaparecen el outbox/inbox, las proyecciones y los consumidores idempotentes que solo existían para coordinar servicios.
- El CI tiene que levantar el sistema completo para Playwright, y la cátedra lo levanta desde un clon limpio.
- Somos tres y la entrega final es el 02/12/2026.

Queda registrado en un ADR nuevo (0006) que marca como reemplazada la decisión de microservicios: es un ADR con una alternativa descartada de verdad.

```
 Web React (apps/web) ── REST + SSE ──▶ api (Express 5, services/api)
                                         ├─ identidad   registro, login, JWT, roles
                                         ├─ flotas      choferes, vehículos, flotas, zonas, límite (variante G)
                                         ├─ ubicacion   pings, búsqueda de candidatos, seguimiento (6.6)
                                         ├─ viajes      solicitud, ofertas, asignación única (6.3), estados, historial
                                         └─ tarifas     tarifa, cobro simulado
                                        Postgres + PostGIS (una base) · Redis (GEO, idempotencia, rate limit, pub/sub)
 k6 (carga/) ──▶ api      Playwright (e2e/) ──▶ web      Grafana Alloy ──▶ Grafana Cloud (opcional, por perfil)
```

### Estructura objetivo

```
packages/kernel · platform · contracts      se conservan
services/api/
  prisma/schema.prisma + migrations/        una sola base
  src/modulos/<modulo>/dominio/             entidades, casos de uso, puertos, errores
  src/modulos/<modulo>/infra/               http, db, memoria, externos
  src/modulos/<modulo>/index.ts             lo único que otro módulo puede importar
  src/config/ · src/composicion.ts · src/servidor.ts
  tests/{dominio,integracion,seguridad,concurrencia}/
apps/web/            React + Vite + Zustand
e2e/                 Playwright
carga/               k6: simulador de choferes, carga y estrés
observabilidad/      configuración de Alloy y dashboards exportados (JSON)
demo/                colección de requests de la demo
docs/                adr/, modelo.md, api.md, mediciones.md, ataque.md, evidencias/
```

ESLint: `src/modulos/*/dominio/**` no importa infraestructura (regla actual, con el glob nuevo) y un módulo no importa el interior de otro, solo su `index.ts`.

### Qué pasa con lo que ya está hecho

| Hoy | Destino | Trabajo |
|---|---|---|
| `packages/kernel`, `platform`, `contracts` | Igual | Sumar a `platform`: helmet, CORS, rate limit genérico, log por pedido, métricas, idempotencia, validación de encabezados |
| `services/dispatch` (dominio, repositorio, 63 tests) | `modulos/viajes` | `git mv`. `SolicitudViaje` pasa a ser el viaje completo (ver 3.1) |
| `services/identity` (registro, login, argon2id, RS256, límite de login, seed) | `modulos/identidad` | `git mv`. El token se verifica con la clave pública local (`verificadorJwksLocal` ya existe); `fleet_id` gana su FK |
| Refresh con rotación y detección de reuso (PR #3, mergeado) | `modulos/identidad` | Se mueve con el resto de identity |
| Tabla `outbox` | Se conserva | Es la fuente de los eventos de tiempo real; ya no hay relay a RabbitMQ ni inbox |
| Barrido de ofertas vencidas | Se conserva tal cual | No hace falta BullMQ: el vencimiento ya no depende del cliente |
| `docker-compose.yml`, `infra/postgres/init` | Simplificar | Fuera `rabbitmq`, `dispatch` e `identity`; entra `api`. Bases `viajes` y `viajes_test`, con un usuario que no es superusuario |
| `Dockerfile` genérico | Igual | `SERVICE=api` |
| CI (typecheck, lint, tests, audit) | Ampliar | Jobs de E2E y SAST |
| ADR 0004 | Ajustar formato | Le faltan «quiénes participaron» y «qué nos haría cambiar de decisión»; sacar las menciones a M5 y a eventos |
| `docs/arquitectura.md`, `docs/eventos.md`, README | Reescribir | Describen microservicios |

**Se descarta del plan anterior:** passengers (M2), notifications con PDF y tickets (M8), reservations (M9: los viajes programados son la variante B, no la nuestra), gateway, realtime como servicio, QR de un solo uso, reintegros y liquidación, JWKS remoto, denylist de `jti`, RabbitMQ, BullMQ, PWA instalable, imágenes en GHCR y `trazabilidad.md`.

## 3. Diseño por módulo

### 3.1 viajes — asignación única (6.3) y ciclo de vida

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
- Candidatos: el puerto `BuscadorCandidatos` pasa de la lista fija a `ubicacion`, filtrado por la zona del origen y las flotas habilitadas.

### 3.2 ubicacion — tarea pesada (6.6) y búsqueda geográfica (6.4)

- **Ingenua** (`UBICACION_ESTRATEGIA=ingenua`): un `INSERT` por ping, y la búsqueda trae todos los choferes y calcula haversine en JavaScript, de forma sincrónica.
- **Final** (`optimizada`, cambia solo en `composicion.ts`):
  - posición vigente en Redis `GEOADD`, con vencimiento para no ofrecer choferes fantasma;
  - búsqueda con `GEOSEARCH`;
  - historial fuera del pedido HTTP: cola en Redis y escritura en lotes.
  - De las cuatro estrategias de 3.3 es la **cola**, más un índice geográfico. Va en el ADR 0005.
- El ADR 0008 compara Redis GEO, PostGIS y geohash (6.4 pide al menos dos opciones con su costo).
- Retención: puntos crudos solo durante el viaje, conservados 30 días; pings de choferes sin viaje, descartados a las 24 h.
- Seguimiento: la posición del chofer solo la ve su pasajero actual, y la del pasajero solo su chofer asignado. Con test.
- Tiempo declarado hasta la asignación bajo carga: lo fija el grupo **antes** de medir y va como hipótesis.

### 3.3 flotas — variante G

- Choferes con vehículo y habilitación que otorga el admin. Disponible / no disponible.
- Flotas con `admin_flota`. El `fleetId` sale del token y se filtra **en el caso de uso**. Pedir algo de otra flota devuelve 404, con test.
- Zonas operativas: polígonos en PostGIS. Se resuelve la zona del origen una vez por solicitud y se ofrece solo a choferes de flotas con esa zona habilitada.
- **Carrera G:** `UPDATE fleets SET active_count = active_count + 1 WHERE id = $1 AND active_count < max_active RETURNING ...`, más `CHECK (active_count <= max_active)`. Test: 50 activaciones simultáneas con límite 10 dejan exactamente 10.
- Reporte por flota: choferes activos, viajes y facturación.

### 3.4 tarifas

- Una sola función para la estimación y la tarifa final, en **centavos enteros**. Se guarda por qué difieren.
- Tests de borde: distancia cero y viaje que supera el máximo.
- Cobro simulado detrás de un puerto de pagos, idempotente, que **falla cerrado**.
- Puerto de mapas (distancia y tiempo) con adaptador simulado y adaptador falso.

### 3.5 Transversales

- **Idempotency-Key** en todo lo que crea, cobra o dispara un efecto (registro, solicitud, aceptación, cancelación, finalización, cobro, activación de chofer):
  - `SET NX` en Redis mientras el pedido está en vuelo; el duplicado concurrente recibe 409;
  - registro en Postgres **en la misma transacción que el efecto**, con hash del cuerpo y la respuesta;
  - el reintento recibe la respuesta guardada; la misma clave con otro cuerpo, 422.
  - Hoy no existe en ningún endpoint.
- **Tiempo real por SSE**, en el mismo proceso:
  - un relay lee el `outbox` y publica en Redis Pub/Sub; el endpoint SSE se suscribe solo a los viajes del usuario;
  - los pings de un chofer con viaje activo se publican en el canal de ese viaje;
  - al reconectar, el cliente pide el estado actual (`GET /viajes/:id`) y se vuelve a suscribir con `Last-Event-ID`.
- **Inventario de carreras** (bloque 6, punto 1), en un ADR: aceptar contra aceptar, aceptar contra cancelar, chofer con dos viajes, pasajero con dos solicitudes, vencimiento contra aceptación, activación de choferes, email duplicado en el registro, clave de idempotencia duplicada y doble finalización con doble cobro.

## 4. Requisitos de ProgIV: estado al 13/11

✅ hecho · 🟡 parcial · ⬜ falta. El CI está en verde en `main`. Hay 188 tests: 63 de dispatch y 125 de identity.

| Requisito | Estado | Qué falta |
|---|---|---|
| **B1** Arranque reproducible | 🟡 | La secuencia de 2.4 **hoy falla**: `.env.example` trae vacía la clave RS256 y hay que migrar a mano. Faltan `npm run setup`, `dev` y `start` en la raíz. `setup` genera la clave si no existe y tiene que andar en Windows y Linux (script de Node, no bash) |
| **B2** Hexagonal | ✅ | Mantenerlo en cada módulo nuevo. Puertos con doble adaptador: mapas, pagos, notificador, publicador de eventos |
| **B3** Configuración y ciclo de vida | ✅ | Preparar la demo de SIGTERM con un pedido lento |
| **B4** Errores y logs | 🟡 | No hay **log por pedido** (método, ruta, estado, duración): hoy solo se loguean los errores, y no se puede relacionar pedido y error por `requestId` |
| **B5** Autenticación | ✅ | argon2id con costo declarado, RS256 |
| **B5** Autorización por recurso | 🟡 | Hecha y testeada en viajes. Falta en flotas, ubicación e historial |
| **B5** Tres roles con tabla en el README | 🟡 | Hay cinco roles en código; falta la tabla |
| **B5** Validación con esquema | 🟡 | Cuerpo, parámetros y query sí. Falta validar **encabezados** (`Idempotency-Key`) |
| **B5** Prototype pollution | 🟡 | Solo se prueba `__proto__` en la raíz. Falta `constructor.prototype` y posiciones anidadas |
| **B5** Inyección SQL | 🟡 | Consultas parametrizadas sí. Falta el test con una carga típica en un campo de búsqueda |
| **B5** Límite de tasa | 🟡 | Solo en login. Falta en solicitud de viaje y ubicación, con 429 y encabezados |
| **B5** Helmet y CORS | ⬜ | Estaban pensados para el gateway: van en `crearApp` |
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

La cátedra publicó 20 temas. Elegimos los tres que ProgIV ya obliga a resolver, así no agregan trabajo:

| Tema (pregunta guía) | Dónde queda en el proyecto | Demostración |
|---|---|---|
| **Condiciones de carrera y control de concurrencia** («¿cómo impedir que dos procesos asignen el mismo recurso?») | Asignación única (6.3), **ya hecha**, y la carrera G | Test de 50 aceptaciones: 1 gana. Sacar el `FOR UPDATE` y ver cómo falla |
| **Idempotencia y deduplicación** (nuestra exposición) | `Idempotency-Key` (3.5) | La misma petición dos veces y veinte en simultáneo: un solo efecto |
| **Redis: caché y datos efímeros** (nuestra exposición; «¿qué datos conviene mantener en memoria y cómo evitar información obsoleta?») | Posiciones de choferes en Redis GEO con vencimiento (6.6); caché de tarifas y zonas con invalidación al editarlas | Chofer que deja de reportar y desaparece de la búsqueda; HIT, MISS e invalidación |

De reserva, también cubiertos por lo obligatorio:
- **OAuth 2.0/OIDC, JWT y autorización**: JWT RS256 y autorización por recurso ya están; no hay OAuth ni OIDC.
- **Docker Compose**: ya se usa, pero el tema dice «sistema distribuido» y tenemos un solo backend.
- **Bulkhead, rate limiting y backpressure**: solo tendríamos el rate limiting.
- **Publicación/suscripción y eventos**: Redis Pub/Sub alimenta el SSE.
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

Se usa **Semgrep** y no CodeQL porque el repositorio es privado y CodeQL en privados necesita GitHub Advanced Security.

### 5.5 k6 (10)

En `carga/`, corriendo con la imagen `grafana/k6`:
- `choferes.js`: el **simulador propio** de 6.6. 500 usuarios virtuales, un ping cada 2 s, cinco minutos o más.
- `solicitudes.js`: carga sobre la solicitud de viaje con choferes que aceptan; mide p50, p95 y p99, pedidos por segundo y **tiempo hasta la asignación**.
- `estres.js`: rampa hasta encontrar dónde se degrada.
- `carrera.js`: aceptaciones simultáneas, para el informe de la carrera principal.

Cada escenario tiene umbrales, tres corridas de 30 s o más, y los resúmenes van a `docs/mediciones.md`, con hipótesis escrita antes.

Dos detalles: el simulador necesita 500 tokens y el límite de login por IP (30 cada 15 minutos) lo bloquearía, así que el seed de carga los emite o se sube el límite en ese entorno. Y `/health` se mide en paralelo, como pide el bloque 7.

### 5.6 Grafana Cloud (10)

- `/metrics` con `prom-client`: latencia por ruta, lag del event loop (`monitorEventLoopDelay`), memoria, y métricas de negocio (solicitudes, asignaciones, ofertas vencidas, tiempo hasta la asignación, pings por segundo).
- **Grafana Alloy** en un perfil de Compose (`--profile obs`) envía métricas y los logs JSON a Grafana Cloud.
- Dashboards: salud del servicio, despacho y tarea pesada. Se exportan como JSON a `observabilidad/`.
- Las credenciales van solo en `.env`. **Sin ellas el sistema levanta igual**: lo exigen la secuencia de 2.4 y la defensa sin internet.
- `/metrics` no queda expuesto al grupo atacante.

## 6. Hoja de ruta

**Única fecha confirmada: entrega final el 02/12/2026.** Los controles, el congelamiento, el ataque cruzado y la defensa no tienen fecha confirmada ([consulta 5](docs/consultas-catedra.md)); tampoco la entrega y el coloquio del Integrador (consulta 4). Todo el trabajo se planifica para terminar el 02/12. Las fechas de corte de las fases son **metas internas del grupo**, no fechas de la cátedra, y se reacomodan cuando la cátedra confirme las suyas.

Del 13/11 al 02/12 quedan 19 días. No alcanza para todo con holgura: el orden de recorte del final de esta sección es parte del plan.

### Fase A — meta interna 18/11: «problema difícil»

Es lo que pide el Control 3: carrera principal con su test (ya está) y tarea pesada en dos versiones con la primera medición.

- [ ] Confirmar con la cátedra si se exigen microservicios ([consulta 1](docs/consultas-catedra.md)). El resto de la fase no depende de la respuesta.
- [ ] **Con esa respuesta**, consolidar en `services/api` (Ivan). Durante esos dos días no se mergea otra cosa.
- [ ] `npm run setup`, `dev`, `start`; Compose simplificado; secuencia de 2.4 probada en un clon limpio (Ivan).
- [ ] `ubicacion` en sus dos versiones, con adaptador en memoria primero (Maxi).
- [ ] `carga/choferes.js`, `carga/solicitudes.js`, `/metrics` con el lag y **primera medición** en `docs/mediciones.md` (Maxi).
- [ ] `flotas`: choferes, vehículos, flotas y la carrera G con su test (Agos).
- [ ] ADR 0001, 0002, 0003, 0005 y 0006; 0004 con el formato corregido.

### Fase B — meta interna 25/11: sistema completo y publicado

Al cerrar esta fase el sistema tiene que poder congelarse para el ataque cruzado, cuando la cátedra lo fije.

- [ ] `viajes`: estados completos, historial, panel del operador con búsqueda (Ivan).
- [ ] Idempotency-Key y SSE (Ivan).
- [ ] Zonas, candidatos filtrados por flota y zona, reporte, aislamiento entre flotas (Agos).
- [ ] Seguridad transversal: helmet, CORS, rate limit, encabezados, log por pedido y los tests que faltan del bloque 5 (Agos).
- [ ] `tarifas`, cobro simulado y adaptadores de mapas y pagos con timeout (Maxi).
- [ ] Caché en Redis, retención de ubicaciones y privacidad del seguimiento (Maxi).
- [ ] Frontend mínimo: base y login (Agos), pasajero y operador (Ivan), chofer (Maxi).
- [ ] `modelo.md`, `api.md`, tabla de roles, colección de la demo y usuarios de prueba.
- [ ] Despliegue accesible para el grupo atacante y tag `congelado`.

### Fase C — del 25/11 a la entrega del 02/12: rúbrica del Integrador y cierre

- [ ] Playwright y job `e2e` (Agos, Ivan).
- [ ] Job `sast` y corrección de lo que encuentre (Ivan).
- [ ] Grafana Cloud y dashboards; `estres.js` y `carrera.js` (Maxi).
- [ ] Mediciones finales, tres corridas por escenario, con conclusión (Maxi).
- [ ] ADR restantes: 0007 SSE, 0008 búsqueda geográfica, 0009 límite por flota, 0010 idempotencia, 0011 vencimiento de ofertas, 0012 inventario de carreras.
- [ ] Autoevaluación de ProgIV 10.6 completa, clon limpio en otra máquina y tag `entrega-final` **el 02/12** (Ivan).

### Ataque cruzado — fecha a confirmar

Se hace cuando la cátedra lo fije; el entorno publicado no se toca durante esa semana.
- [ ] Bitácora del ataque en `docs/ataque.md`: Agos (autenticación, acceso a recursos ajenos, rate limit), Ivan (carreras e idempotencia), Maxi (validación, montos, operaciones costosas).
- [ ] Hallazgos recibidos: causa raíz, commit y un test que falla antes y pasa después (el dueño del módulo).

Si la cátedra lo ubica antes del 02/12, desplaza trabajo de la Fase C y se recorta según el orden de abajo. Si queda después de la entrega, hay que preguntar cómo entran las correcciones, porque lo posterior al tag `entrega-final` no se corrige.

### Defensa de ProgIV y coloquio del Integrador — fechas a confirmar

Cada dueño le explica su parte a los otros dos. Ensayar los cuatro tipos de pregunta de ProgIV 9.2 (predicción, diagnóstico, modificación en vivo, justificación de un ADR) y, para el Integrador, interpretar en vivo el pipeline, k6 y los dashboards.

**Si falta tiempo, en este orden:** bloques comunes de ProgIV (un bloque ausente limita la nota a 5) → 6.3, 6.6 y variante G → ataque cruzado → k6, CI con SAST y Playwright → Grafana Cloud → frontend más allá de lo que Playwright necesita.

## 7. Verificación

1. Clon limpio en otra máquina: `cp .env.example .env`, `docker compose up -d`, `npm run setup`, `npm test`, `npm start` y la colección de la demo.
2. Borrar una variable: el proceso sale con código distinto de cero y nombra la variable.
3. SIGTERM durante un pedido lento: el log muestra que terminó antes de salir.
4. Un error provocado: respuesta sin detalles internos, y pedido y error encontrados por `requestId`.
5. Tests de concurrencia: 50 aceptaciones dejan 1 asignación; cancelar contra aceptar; 50 activaciones con límite 10 dejan 10. Cada uno **falla si se saca la protección**.
6. La misma `Idempotency-Key` dos veces: un solo efecto.
7. Demo de 6.8: ciclo completo con seguimiento, oferta que vence con el chofer desconectado, ubicación ajena rechazada, 500 choferes con medición antes y después, variante G con su carrera.
8. `npm run test:e2e` en verde, y el pipeline completo en verde en GitHub.
9. k6 en versión ingenua y optimizada, con los números en `docs/mediciones.md`.
10. Dashboards de Grafana Cloud mostrando una corrida de k6.

## 8. Preguntas para la cátedra

Están en [docs/consultas-catedra.md](docs/consultas-catedra.md), con lo que asumimos mientras tanto y el lugar para anotar cada respuesta. La primera (si se exigen microservicios) es la única que frena trabajo: bloquea la consolidación de la Fase A.
