# ADR 0012 — Inventario de carreras: cada invariante la garantiza la base, o un script atómico en Redis

- **Estado:** aceptado
- **Fecha:** 2026-11-24. Registra lo que ya está en `main` hasta #42.
- **Quiénes participaron:** Ivan (inventario y ADR). Revisión: pendiente (Agos y Maxi).
- **Servicios:** dispatch, identity y location; idempotencia en `platform` — PLAN 3.5 y bloque 6 (B6)

## Contexto

El enunciado (3.5) pide el inventario completo de las condiciones de carrera: cada par de operaciones que pueden pisarse, qué saldría mal y qué lo impide. Los ADR anteriores cubren piezas sueltas: la asignación única ([0004](0004-asignacion-unica.md)), el outbox ([0007](0007-tiempo-real-sse.md)), la Idempotency-Key ([0010](0010-idempotencia.md)) y el vencimiento de ofertas ([0011](0011-vencimiento-ofertas.md)). Este junta todo en una tabla y marca lo que no tiene protección o no tiene test.

Condiciones de partida: cada servicio puede correr con más de una réplica, los clientes reintentan, y dos usuarios pueden tocar el mismo recurso en el mismo milisegundo.

## Opciones consideradas

| Opción | Por qué no / por qué sí |
|---|---|
| **Leer y después escribir** (*check-then-act*) en el código | Incorrecto: entre la lectura y la escritura otra transacción cambia el estado. Es exactamente la carrera |
| **Mutex en memoria** | Solo vale dentro de un proceso. Con dos réplicas, la carrera vuelve |
| **Lock distribuido en Redis** como garantía | Puede vencer en medio de la operación y no es atómico con la escritura en Postgres ([ADR 0004](0004-asignacion-unica.md)). Lo usamos solo para frenar duplicados en vuelo; la garantía queda en la base ([ADR 0010](0010-idempotencia.md)) |
| **`SERIALIZABLE` en todo** | Correcto, pero obliga a reintentar en cada camino, y los errores dependen del plan de ejecución |
| **Cada invariante, en la base o en un script atómico** | La elegida: `FOR UPDATE`, `UPDATE` condicional, `UNIQUE`, `CHECK` o advisory lock en Postgres (READ COMMITTED); scripts Lua en Redis para lo que vive en Redis |

## Decisión

Cada invariante tiene un mecanismo que no depende de cuántas réplicas haya. Los locks se toman siempre en el mismo orden: **solicitud → chofer → zona de la flota** en dispatch, **chofer → flota** en flotas y **familia → token** en identity. Nadie los toma al revés, así que no hay interbloqueos.

Rutas relativas a `services/<servicio>/`. Abreviaturas: `repo` = `src/infra/db/repositorio-prisma.ts`, `flotas-db` = `src/infra/db/flotas-prisma.ts`, `conc/` = `tests/concurrencia/`. Los archivos sin carpeta son casos de uso (`src/dominio/casos-uso/`), salvo `oferta.ts` (`src/dominio/entidades/`), `chofer.ts` (`src/dominio/flotas/`) y `sse.ts` (`src/infra/tiempo-real/`).

### Asignación y ofertas (dispatch)

| # | Carrera | Qué puede salir mal | Qué lo impide | Dónde | Test |
|---|---|---|---|---|---|
| 1 | Dos (o 50) choferes aceptan el mismo viaje | Dos choferes asignados | `FOR UPDATE` de la solicitud; la segunda relee `ASIGNADO` → 409 `SOLICITUD_NO_DISPONIBLE`. Segunda barrera: `UNIQUE driver_active_assignment.request_id` | `aceptar-oferta.ts`, `repo` | `conc/asignacion-unica.test.ts`: 50 aceptan, 1×200 y 49×409 |
| 2 | Un chofer con dos ofertas acepta las dos | Chofer con dos viajes | PK `driver_active_assignment.driver_id` con `INSERT … ON CONFLICT DO NOTHING` → 409 `CHOFER_CON_VIAJE_ACTIVO` | `repo` (`reservarChofer`) | `conc/asignacion-unica.test.ts`: un chofer, dos solicitudes, 20 repeticiones |
| 3 | Aceptar contra vencer (barrido) | Aceptar una oferta que el barrido ya venció y reofreció | Mismo `FOR UPDATE`; se releen las ofertas después del lock y la vigencia se compara con el reloj del servidor → 409 `OFERTA_VENCIDA` | `aceptar-oferta.ts`, `vencer-ofertas.ts`, `oferta.ts` | Solo de dominio: `tests/dominio/entidades.test.ts` y `casos-uso.test.ts`. **Sin test de concurrencia contra Postgres** |
| 4 | Dos barridos (dos réplicas) sobre la misma solicitud | Dos tandas nuevas, `OfferExpired` repetido | Mismo `FOR UPDATE` y relectura; tanda nueva solo si no queda ninguna vigente; `UNIQUE offers(request_id, driver_id)`. En un proceso, `iniciarBarrido` no superpone pasadas | `vencer-ofertas.ts`, `packages/platform/src/barrido.ts` | **Sin test** |
| 5 | Aceptar contra cancelar del pasajero | Viaje cancelado con chofer bloqueado | Mismo `FOR UPDATE`. Si gana la cancelación, la aceptación da 409; si gana la aceptación, la cancelación libera al chofer en la misma transacción | `cancelar-solicitud.ts` | `conc/asignacion-unica.test.ts`: cancelar contra aceptar, 20 repeticiones |
| 6 | Aceptar contra cancelar del operador | Ídem | Mismo caso de uso y mismo lock que la fila 5 (cambia solo `quien`) | `cancelar-solicitud.ts` | **Sin test propio.** El de la fila 5 recorre el mismo código; el operador está probado contra finalizar (fila 11) |
| 7 | Aceptar contra desactivar al chofer (admin de flota) | Viaje asignado a un chofer inactivo | `FOR SHARE` de `drivers` al aceptar contra el `FOR UPDATE` de desactivar; Postgres reevalúa `approved AND active AND available` → 409 `CHOFER_NO_APTO` | `repo` (`choferAptoParaAceptar`), `flotas.ts` | `conc/aceptar-vs-flota.test.ts`: los dos órdenes |
| 8 | Aceptar contra deshabilitar (admin) o contra «no disponible» (el chofer) | Ídem | El mismo `FOR SHARE` contra el mismo `FOR UPDATE` de `drivers` | `repo`, `flotas.ts` | **Sin test propio.** Lo cubre el mecanismo de la fila 7 |
| 9 | Aceptar contra quitarle la zona a la flota | Viaje en una zona donde la flota ya no opera | `FOR SHARE` de `fleet_zones` contra el `DELETE` de esa fila → 409 `CHOFER_NO_APTO` | `repo`, `flotas-db` | `conc/aceptar-vs-flota.test.ts`: los dos órdenes |
| 10 | Un pasajero pide N viajes a la vez | Dos solicitudes activas | Índice único parcial `ride_requests_una_activa_por_pasajero` con `ON CONFLICT DO NOTHING` → 409 `SOLICITUD_ACTIVA_EXISTENTE` | `repo` (`insertarSolicitud`), migración inicial | `conc/asignacion-unica.test.ts`: 10 a la vez, una sola |

### Ciclo del viaje y cobro (dispatch)

| # | Carrera | Qué puede salir mal | Qué lo impide | Dónde | Test |
|---|---|---|---|---|---|
| 11 | Finalizar contra la cancelación del operador | Viaje completado y cancelado, o chofer que queda bloqueado | Mismo `FOR UPDATE`; finalizar borra la asignación (`liberarChofer`) y crea el cobro en la misma transacción que la transición | `avanzar-viaje.ts` | `conc/asignacion-unica.test.ts`: 20 repeticiones, gana uno y el chofer queda libre |
| 12 | Dos finalizaciones del mismo viaje (claves distintas) | Dos `RideCompleted`, dos cobros | `FOR UPDATE` y la transición en la entidad → 409; `UNIQUE payments.request_id` | `avanzar-viaje.ts`, `repo` (`insertarCobro`) | `conc/asignacion-unica.test.ts`: 20 finalizaciones, 1×200; `conc/cobro.test.ts`: un solo cobro |
| 13 | Dos acciones distintas sobre el mismo viaje (en camino, iniciar, cancelar, dos cancelaciones) | Transiciones superpuestas | Todas toman el mismo `FOR UPDATE`; la segunda ve el estado nuevo → 409 | `avanzar-viaje.ts`, `cancelar-solicitud.ts` | Cubierto por las filas 11 y 12. **Sin test concurrente** de dos cancelaciones ni de en camino contra cancelar |
| 14 | Dos cobros del mismo viaje (20 `POST /cobrar` y el barrido) | El proveedor cobra dos veces; dos `PaymentCaptured` | El id del cobro es la clave de idempotencia con el proveedor; el resultado se registra con `FOR UPDATE` de `payments` y solo si sigue `PENDIENTE`; un fallo tardío no pisa un cobro resuelto (`UPDATE … WHERE status = 'PENDIENTE'`) | `cobrar.ts`, `repo` | `conc/cobro.test.ts`: 20 pedidos y el barrido, un cobro y un evento |

### Flotas, zonas y tarifa (dispatch)

| # | Carrera | Qué puede salir mal | Qué lo impide | Dónde | Test |
|---|---|---|---|---|---|
| 15 | **Carrera G:** activaciones simultáneas contra el límite de la flota | Más activos que `max_active` | `UPDATE fleets SET active_count = active_count + 1 WHERE active_count < max_active`; `CHECK fleets_cupo_check` | `flotas-db` (`ocuparCupo`), migración `flotas` | `conc/flotas.test.ts`: 50 activaciones con límite 10, quedan 10 |
| 16 | Dos activaciones del mismo chofer | Un chofer ocupa dos cupos | `FOR UPDATE` de `drivers`; la segunda lo ve activo y no ocupa cupo | `flotas.ts`, `flotas-db` | `conc/flotas.test.ts`: mismo chofer, claves distintas |
| 17 | Activar y desactivar mezclados | Contador desincronizado | `FOR UPDATE` del chofer; solo libera cupo si estaba activo; `CHECK active_count >= 0` | `flotas.ts`, `chofer.ts` | `conc/flotas.test.ts`: el contador coincide con los activos |
| 18 | Bajar el límite contra activaciones | Límite menor que los activos | `ON CONFLICT DO UPDATE … WHERE active_count <= EXCLUDED.max_active` sobre la misma fila que el `UPDATE` condicional; `CHECK` | `flotas-db` (`guardarFlota`) | `tests/integracion/flotas.test.ts`, en serie, y el `CHECK`. **Sin test concurrente** |
| 19 | Dos altas del mismo chofer o de la misma patente | Chofer en dos flotas, patente repetida | PK `drivers.id` y `UNIQUE vehicle_plate`, con `ON CONFLICT DO NOTHING` | `flotas-db` (`insertarChofer`) | `tests/integracion/flotas.test.ts`, en serie. **Sin test concurrente** |
| 20 | Dos `PUT` de zonas superpuestas | Dos zonas que se pisan (un `CHECK` no ve otras filas) | `pg_advisory_xact_lock` sobre todas las escrituras de zonas | `flotas-db` (`guardarZona`) | `tests/integracion/zonas.test.ts`: dos simultáneos, pasa uno |
| 21 | Dos reemplazos de las zonas de la misma flota | Resultado mezclado | `FOR NO KEY UPDATE` de la flota | `flotas-db` (`reemplazarZonasDeFlota`) | **Sin test concurrente** |
| 22 | Dos admins editan la tarifa; diez réplicas siembran a la vez | Versiones repetidas o salteadas; dos versiones 1 | `FOR UPDATE` de la única fila de `fare_current`; PK de la versión y `UNIQUE previous_version`; la semilla con `ON CONFLICT DO NOTHING` | `src/infra/db/tarifas-prisma.ts` | `conc/tarifas.test.ts`: 2 y 5 admins, el caché y la semilla |

### Idempotencia (`platform`, dispatch e identity)

| # | Carrera | Qué puede salir mal | Qué lo impide | Dónde | Test |
|---|---|---|---|---|---|
| 23 | La misma Idempotency-Key en simultáneo | Dos efectos; la búsqueda en location o el cobro repetidos | Cerrojo `SET NX PX` → 409 `CLAVE_IDEMPOTENCIA_EN_CURSO`; PK `(scope, key)` de `idempotency_keys` en la transacción del efecto | `packages/platform/src/idempotencia.ts`, `idempotencia-sql.ts` | dispatch `conc/idempotencia.test.ts` (crear y finalizar), `conc/flotas.test.ts`, `conc/tarifas.test.ts`, `tests/integracion/flotas.test.ts` (flota y disponibilidad); identity `conc/registro-y-login.test.ts` |
| 24 | El cerrojo vence con el pedido en curso | El duplicado llega al caso de uso | La PK del registro, en la transacción, impide el segundo efecto | ídem | dispatch `tests/seguridad/idempotencia.test.ts` y `tests/seguridad/tarifas-admin.test.ts` |
| 25 | Soltar el cerrojo que ya tomó otro pedido | Un tercer duplicado entra | Lua: compara el token y borra en un paso (`SOLTAR`) | `packages/platform/src/idempotencia.ts` (`cerrojoRedis`) | **Sin test** de que un pedido no suelta el cerrojo que ya tomó otro |
| 26 | La purga en varias réplicas | Errores o borrados dobles | `FOR UPDATE SKIP LOCKED` por lotes | `packages/platform/src/idempotencia-sql.ts` | dispatch `tests/integracion/purga-idempotencia.test.ts` |

### Identity

| # | Carrera | Qué puede salir mal | Qué lo impide | Dónde | Test |
|---|---|---|---|---|---|
| 27 | Registro del mismo email (claves distintas) | Dos cuentas con el mismo email | `UNIQUE users_email_key` con `ON CONFLICT DO NOTHING` (`skipDuplicates`) → 409 `IDENTIFICADOR_EN_USO` | `repo` de identity (`insertar`) | `conc/registro-y-login.test.ts`: 20 a la vez, 1 gana |
| 28 | Refresh token reusado en paralelo | Dos sesiones nuevas desde un mismo token | Advisory lock por familia y `UPDATE … WHERE used_at IS NULL`; el resto cuenta como reuso y revoca la familia | `repo` de identity (`rotar`) | `conc/registro-y-login.test.ts`: 20 refresh, 1 rota; reuso de uno viejo durante una rotación |
| 29 | Logout contra refresh | Un token nuevo que sobrevive al logout | El mismo advisory lock por familia | `cerrar-sesion.ts`, `repo` de identity | `conc/logout.test.ts`: los dos casos |
| 30 | Logins con contraseña mala en paralelo | Pasar el límite de intentos | Lua: `INCR` y `PEXPIRE` atómicos, contados antes de verificar | `src/infra/limite/limitador-redis.ts`, `src/infra/http/limite-login.ts` | `conc/registro-y-login.test.ts`: 50 intentos, 5 llegan a verificar |

### Tiempo real y location

| # | Carrera | Qué puede salir mal | Qué lo impide | Dónde | Test |
|---|---|---|---|---|---|
| 31 | Relay del outbox en varias réplicas | Un evento publicado dos veces, o perdido | Outbox en la transacción del efecto; relay con `FOR UPDATE SKIP LOCKED`; el stream descarta `seq` repetidos | dispatch `src/infra/tiempo-real/outbox-prisma.ts`, `sse.ts` | `conc/relay.test.ts`: 4 relays, 300 eventos; `tests/integracion/tiempo-real.test.ts` |
| 32 | Un `seq` menor confirma después de uno mayor (viajes distintos del mismo usuario) | Al reconectar con `Last-Event-ID`, ese evento no se repone | **Nada en el servidor.** El cliente relee el estado al reconectar ([ADR 0007](0007-tiempo-real-sse.md)) | — | **Sin test.** Aceptado |
| 33 | Streams SSE simultáneos del mismo usuario | Pasar el límite de 3 | El cupo se reserva antes de cualquier `await`, en un `Map` del proceso | dispatch `sse.ts` | `tests/integracion/tiempo-real.test.ts`, en serie. **El límite es por réplica** |
| 34 | Pings del mismo chofer que se cruzan | Una posición vieja pisa o se publica después de una nueva | Lua `GUARDAR` y `PUBLICAR`: no escriben ni publican un ping más viejo | location `src/infra/redis/repositorio-geo.ts`, `publicador-posiciones.ts` | location `tests/integracion/publicacion.test.ts`: 50 pings cruzados; `tests/soporte/casos-compartidos.ts` |

## Lo que queda sin protección o sin test

**Sin protección en el servidor:**

- **Fila 32.** Un evento de otro viaje puede no reponerse al reconectar. Lo cubre el cliente, que relee el estado.
- **Fila 33.** El límite de 3 streams es por proceso: con N réplicas de dispatch, un usuario puede abrir 3×N. Hoy el Compose levanta una sola réplica.
- **Fila 14, con dos réplicas.** El proveedor de pagos simulado recuerda las claves en la memoria del proceso (`services/dispatch/src/infra/externos/pagos-simulado.ts`). Dos llamadas con la misma clave desde réplicas distintas cobrarían dos veces en el simulado, aunque se registre un solo resultado y un solo `PaymentCaptured`. Un proveedor real guarda la clave de su lado. Además, `cobrosPendientes` no usa `SKIP LOCKED`: con dos réplicas, los dos barridos llaman al proveedor por el mismo cobro y dependen de esa clave.
- **Ofertas a un chofer que acaba de tomar otro viaje.** El filtro de aptos lee sin lock, fuera de la transacción. Puede crear una oferta para un chofer ocupado: aceptarla da 409 `CHOFER_CON_VIAJE_ACTIVO`, pero ocupa un lugar de la tanda hasta que vence. Por la misma razón, las ofertas pendientes de un chofer en otras solicitudes no se cancelan cuando acepta una: vencen solas. No rompe ninguna invariante; puede demorar la asignación hasta un TTL.

**Protegidas, pero sin test de concurrencia:** filas 3 y 4 (aceptar contra vencer y dos barridos), 6, 8, 13 (parcial), 18, 19, 21 y 25.

## Consecuencias

- Las invariantes no dependen de cuántas réplicas haya: viven en Postgres o en un script atómico de Redis.
- Cada `UNIQUE`, `CHECK` y PK de esta tabla es parte del diseño: una migración que los saque rompe una garantía aunque los tests unitarios sigan en verde.
- Los tests de concurrencia corren contra Postgres y Redis reales, con demoras dentro de la transacción (`tests/soporte/demora.ts`, `trasValidarChofer`, `trasBloquearChofer`, triggers de demora en identity) para que las carreras se superpongan de verdad.
- Cada caso de uso nuevo que modifique una solicitud tiene que tomar primero su `FOR UPDATE` y respetar el orden de los locks. Si no, aparece `deadlock detected` (500).

## Cómo se verifica

`npm test` en dispatch e identity corre todo `tests/`, incluido `tests/concurrencia/`, contra Postgres y Redis reales. Cada fila con test indica el archivo. Los ADR 0004, 0007 y 0010 registran que esos tests fallan si se saca el mecanismo (el `FOR UPDATE`, la reserva del chofer, el `SKIP LOCKED`, el cerrojo, el registro en la transacción).

Desde afuera, por HTTP, las mismas carreras se prueban con los scripts de `ataque/` ([docs/ataque.md](../ataque.md)).

## Qué nos haría cambiar de decisión

- **Una réplica más de dispatch en el entorno publicado.** Antes de escalar: el límite de streams pasa a Redis (un contador con TTL por usuario), y el barrido de cobros toma los cobros con `FOR UPDATE SKIP LOCKED`.
- **Un `deadlock detected` o un `could not serialize` en los logs.** Alguien rompió el orden de los locks. Se corrige ese caso de uso.
- **Contención medida en una invariante.** Si `carga/carrera.js` muestra esperas largas en un lock, se pasa ese caso a un `UPDATE` condicional sin lock previo, como la carrera G.
