# Flotas (variante G)

> **Estado:** PR 1 de flotas, y el panel `/flota` de la web ([docs/web.md](web.md#el-panel-de-la-flota-flota)). Hecho: flotas con límite de choferes activos, alta de choferes con su vehículo, habilitación, activación con la **carrera G**, disponibilidad y aislamiento entre flotas. **Falta (PR siguiente):** zonas operativas en PostGIS, filtro de candidatos por flota y zona, y el reporte por flota.

Vive dentro de dispatch ([PLAN.md](../PLAN.md) §3.3): comparte la base y, en el PR siguiente, la transacción con la asignación de viajes.

## Modelo

| Tabla | Qué guarda |
|---|---|
| `fleets` | `id` (el mismo `fleetId` que identity pone en el token del `admin_flota`), `name`, `max_active` y `active_count` |
| `drivers` | `id` (el `sub` del chofer en identity), `fleet_id`, vehículo (`vehicle_plate`, `vehicle_make`, `vehicle_model`), `approved`, `active`, `available` |

**Restricciones de la base** (migración `20261126000000_flotas`):
- `fleets_cupo_check`: `active_count` entre 0 y `max_active`. Es la red de seguridad de la carrera G;
- `drivers_activo_habilitado_check`: no se puede estar activo sin habilitación;
- `drivers_disponible_activo_check`: no se puede estar disponible sin estar activo;
- patente única y con formato argentino (`ABC123` o `AB123CD`). Un chofer está en una sola flota: su id es la clave primaria.

No hay clave foránea hacia identity: las cuentas viven en otra base. Por eso el alta de un chofer pregunta a identity si la cuenta existe y es de chofer (ver [Alta de un chofer](#alta-de-un-chofer)).

## Quién hace qué

| Estado | Lo decide | Regla |
|---|---|---|
| **Habilitado** (vehículo y documentación en regla) | `admin` de la plataforma | — |
| **Activo** en su flota (ocupa un cupo) | `admin_flota` de esa flota | Exige estar habilitado |
| **Disponible** (tomando viajes ahora) | el chofer | Exige estar activo |

## Qué ocupa un cupo y qué lo libera

| Operación | Cupo |
|---|---|
| Activar a un chofer inactivo | **Ocupa uno**. Si la flota está llena: 409 `LIMITE_FLOTA_ALCANZADO` y el chofer queda inactivo |
| Activar a un chofer que ya está activo | No ocupa: responde 200 con su estado |
| Desactivar a un chofer activo | **Libera uno** y lo deja no disponible |
| Deshabilitar (el `admin`) a un chofer activo | **Libera uno**: lo desactiva en la misma transacción |
| Cambiar la disponibilidad | No toca el cupo |
| Bajar el límite | No libera: si queda por debajo de los activos, 409 `LIMITE_MENOR_QUE_ACTIVOS` y no cambia nada |

El cambio del chofer y el del contador van **en la misma transacción**, junto con el registro de la `Idempotency-Key`.

## La carrera G

Cuando muchos `admin_flota` activan choferes a la vez, el límite no se puede pasar ni el contador desincronizarse. En `infra/db/flotas-prisma.ts`:

1. `SELECT … FROM drivers WHERE id = $1 FOR UPDATE`: bloquea **al chofer**. Dos pedidos sobre el mismo chofer se serializan, y el segundo ve que ya está activo, así no ocupa otro cupo.
2. El caso de uso comprueba que el chofer sea de la flota del token (404 si no) y que esté habilitado.
3. Si pasa de inactivo a activo:
   ```sql
   UPDATE fleets SET active_count = active_count + 1
   WHERE id = $1 AND active_count < max_active
   RETURNING active_count
   ```
   Comparar y sumar en una sola sentencia: Postgres bloquea la fila de la flota y quien espera vuelve a evaluar el `WHERE` con el valor nuevo (`READ COMMITTED`). Con 0 filas, la flota está llena: 409 y rollback.
4. `UPDATE drivers SET active = true`.

- **Orden de los locks:** siempre el chofer y después la flota. Activar, desactivar y deshabilitar siguen ese orden, así no se bloquean entre sí.
- **El `CHECK`:** si algún día alguien saltea el `UPDATE` condicional, la base igual rechaza un contador por encima del límite.

### Cómo se sabe que el test detecta la falta de la protección

Cada protección se sacó a propósito (21/11) y se corrieron los tests. Todas hacen fallar al menos uno:

| Sin… | Qué pasa | Qué test falla |
|---|---|---|
| a. la condición `active_count < max_active` (queda el `CHECK`) | El `CHECK` rechaza los excedentes como error 500: ningún 409 | 50 activaciones (esperaba 40 respuestas 409, hubo 0) |
| b. la condición y el `CHECK` | **Quedan 50 activos** con límite 10 | 50 activaciones, mezcladas y dos flotas |
| c. el `UPDATE` atómico (se lee, se compara en JavaScript y se escribe `leído + 1`) | **Los 50 quedan activos** y el contador se desincroniza | 50 activaciones, mezcladas y dos flotas |
| d. el `FOR UPDATE` del chofer | Un chofer activo y el **contador en 2** | Dos pedidos para el mismo chofer |
| e. el registro de la clave dentro de la transacción | Varios pedidos con la misma clave confirman | Las dos pruebas de «misma transacción», y el reintento |
| f. la flota en el alcance de la clave | Con otra flota en el token, se repite la respuesta de la flota anterior (200 en vez de 404) | Alcance por usuario y flota |
| g. la validación de la flota antes de la idempotencia | Con la flota borrada, se repite la respuesta guardada (200 en vez de 404) | La flota del token se valida antes de repetir |
| h. la comparación de la flota del chofer con la del token | Un admin_flota opera sobre choferes de otra flota | Aislamiento (dominio e integración) |
| i. la consulta a identity en el alta | Se da de alta un UUID inexistente o un pasajero (201) | Alta de chofer (dominio e integración) |
| j. liberar el cupo al desactivar | El contador queda alto y la flota se llena para siempre | Liberación del cupo, mezcladas y dominio |

## Alcance por flota

- El `fleetId` sale **del token** del `admin_flota` (lo pone identity) y nunca del pedido: un `fleetId` en el cuerpo da 400.
- Se valida **en el caso de uso** (`dominio/casos-uso/flotas.ts`): cada operación sobre un chofer lo lee y exige que sea de la flota del token. Si es de otra, responde **404 `CHOFER_NO_ENCONTRADO`**, el mismo error que para uno que no existe: no se revela que existe.
- Sin `fleetId` en el token: 403 `FLOTA_NO_ASIGNADA`. Con una flota que dispatch no conoce: 404 `FLOTA_NO_ENCONTRADA`.

## Idempotency-Key

Todas las escrituras de flotas la exigen, y el resultado se guarda **en la misma transacción** que el cambio (`RepositorioFlotasPrisma.enTransaccion`, igual que viajes y tarifas). Si el cerrojo de Redis vence con un pedido en curso, la clave primaria de `idempotency_keys` impide que un segundo pedido con la misma clave confirme.

En las escrituras de `/flota/*`:
- la flota del token se valida **antes** de buscar una respuesta guardada: un token sin flota, o con una flota borrada, no recibe la respuesta de antes;
- el alcance de la clave es **el usuario y la flota** (`<usuario>:flota:<fleetId>`): si el token del mismo usuario pasa a otra flota, la misma clave no repite una respuesta de la flota anterior.

## Alta de un chofer

El `admin_flota` da de alta a un chofer en su flota con `{ choferId, vehiculo }`. El `choferId` tiene que ser **una cuenta real de identity con rol `chofer`**:

- dispatch pregunta a identity con `GET /interno/usuarios/:id` y el token de servicio `IDENTITY_TOKEN_SERVICIO`. identity responde solo `{ id, rol }`: ni email, ni nombre, ni flota;
- un UUID que no existe y la cuenta de un pasajero dan el mismo **422 `CUENTA_NO_ES_CHOFER`**;
- si identity no responde (timeout de `IDENTITY_TIMEOUT_MS`, error de red, 5xx o respuesta fuera de contrato), **503 `IDENTITY_NO_DISPONIBLE`**: falla cerrado, no se da de alta a nadie sin comprobarlo;
- es el mecanismo más chico con información confiable: identity es el dueño de las cuentas y de los roles, y la consulta es una sola, antes de abrir la transacción.

El chofer queda deshabilitado, inactivo y no disponible.

## Rutas

| Ruta | Rol | Qué hace |
|---|---|---|
| `PUT /admin/flotas/:id` `{nombre, maxActivos}` | `admin` | Crea la flota con el id que identity usa como `fleetId`, o cambia su nombre y su límite |
| `POST /admin/choferes/:id/habilitar` y `/deshabilitar` | `admin` | Deshabilitar libera el cupo si estaba activo |
| `GET /flota` | `admin_flota` | Su flota: nombre, límite y activos |
| `GET /flota/choferes?limite&desde` | `admin_flota` | Los choferes de su flota, con `siguiente` para paginar |
| `POST /flota/choferes` `{choferId, vehiculo:{patente, marca, modelo}}` | `admin_flota` | Alta en su flota (201) |
| `GET /flota/choferes/:id` | `admin_flota` | 404 si es de otra flota |
| `POST /flota/choferes/:id/activar` y `/desactivar` | `admin_flota` | Ocupa o libera el cupo |
| `PUT /chofer/disponibilidad` `{disponible}` | `chofer` | Su propio registro, el del token |
| `GET /chofer/estado` | `chofer` | Lo que relee la pantalla del chofer, todo del token: `ahora` (la hora del servidor), `registro` (el suyo, o null si no está en una flota), `viaje` (el activo: `ASIGNADO`, `EN_CAMINO` o `EN_CURSO`) y `ofertas` (las pendientes y sin vencer de solicitudes que siguen buscando; vacía con un viaje activo). Contrato: `EstadoChoferRespuesta` (`packages/contracts/src/chofer.ts`) |

Todas las escrituras llevan `Idempotency-Key`. Los demás roles reciben 403 `ROL_NO_PERMITIDO`.

## Tests

- **Concurrencia, contra Postgres** (`tests/concurrencia/flotas.test.ts`):
  - **50 activaciones simultáneas de choferes distintos contra una flota con límite 10**: exactamente 10 respuestas 200 y 40 con 409; en Postgres, 10 choferes activos y el contador en 10; los que respondieron 200 son exactamente los activos; 10 claves registradas;
  - dos pedidos simultáneos para el mismo chofer, con claves distintas: un solo cupo;
  - 20 pedidos con la misma clave: un solo efecto y una sola clave;
  - activaciones y desactivaciones mezcladas: el contador siempre coincide con los activos;
  - dos flotas a la vez: llenar una no consume el cupo de la otra.
- **Integración** (`tests/integracion/flotas.test.ts`):
  - aislamiento entre flotas, con 404 idéntico al de un chofer inexistente;
  - liberación del cupo al desactivar y al deshabilitar, y el límite que no se puede bajar;
  - reglas de habilitación y disponibilidad;
  - la verificación de la cuenta;
  - la idempotencia por usuario y flota, y el registro en la misma transacción;
  - los `CHECK` de la base.
- **Seguridad** (`tests/seguridad/flotas.test.ts`): 401 y 403 en cada ruta, `admin_flota` sin flota, y la validación de los cuerpos.
- **Dominio** (`tests/dominio/flotas.test.ts`): las reglas de `ChoferFlota` y el alcance en cada caso de uso.
- **El adaptador de identity** (`tests/externos/directorio-identity.test.ts`): cada forma de fallar da 503.
- **De punta a punta:** en identity, `tests/integracion/compatibilidad-dispatch.test.ts` levanta el dispatch real y verifica el alta contra el identity real.
- **La ruta interna de identity** (`tests/seguridad/interno.test.ts`).

## Lo que sigue (PR 2 de flotas)

- Zonas operativas en PostGIS y zonas habilitadas por flota.
- Filtro de candidatos: solo choferes habilitados, activos, disponibles, sin viaje activo y de una flota con la zona del origen habilitada. La aceptación de una oferta va a bloquear también la fila del chofer, y desactivar a un chofer con un viaje en curso va a depender de eso: hoy está permitido.
- Reporte por flota: choferes activos, viajes y facturación.
  - **Los activos ya están:** el cupo de `GET /flota`, mantenido por la carrera G.
  - **Los viajes y la facturación necesitan ampliar el modelo.** `ride_requests` no guarda la flota. Contarlos por la flota *actual* del chofer (con un JOIN a `drivers`) no es confiable: sin el filtro de candidatos, un chofer inactivo, o uno que todavía no estaba en la flota, toma viajes que se le sumarían; y un cambio de flota o una baja futuros reescribirían la historia.
  - **Lo confiable:** guardar `fleet_id` en la solicitud dentro de la transacción de la aceptación (junto con el bloqueo del chofer de la aceptación, de este mismo PR 2). Más un índice `(fleet_id, status, started_at)` para consultar por un período acotado. La facturación, de la tarifa final de los `COMPLETADO` o de los cobros aprobados (a decidir).
