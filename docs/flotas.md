# Flotas (variante G)

> **Estado:** PR 1 y PR 2 de flotas, y el panel `/flota` de la web ([docs/web.md](web.md#el-panel-de-la-flota-flota)). Hecho: flotas con límite de choferes activos, alta de choferes con su vehículo, habilitación, activación con la **carrera G**, disponibilidad, aislamiento entre flotas, **zonas operativas en PostGIS**, **filtro de candidatos por flota y zona** y **revalidación al aceptar** (con la flota guardada en el viaje), el **caché de zonas en Redis** ([abajo](#el-caché-de-zonas-redis)), y el **reporte de viajes y facturación** por flota ([abajo](#el-reporte-de-la-flota)).

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

## Zonas operativas (PR 2)

Las define el `admin` de la plataforma, igual que la habilitación de los choferes, y las habilita por flota. Viven en PostGIS (migración `20261127000000_zonas`).

| Tabla | Qué guarda |
|---|---|
| `zones` | `id`, `name` y `area`, un `geometry(Polygon, 4326)` en lng/lat, con índice GIST y `CHECK (ST_IsValid(area))` |
| `fleet_zones` | `(fleet_id, zone_id)`: las zonas donde opera cada flota |
| `ride_requests.zone_id` | La zona del origen, resuelta **una vez**, al crear la solicitud |
| `ride_requests.fleet_id` | La flota del chofer **al aceptar**, guardada en la misma transacción (ver [Aceptar](#aceptar-revalidación-y-la-carrera-con-la-flota)) |

- **El polígono** llega como un `Polygon` de GeoJSON: solo el anillo exterior, cerrado y de 4 a 1000 vértices. Si se cruza consigo mismo, lo rechaza PostGIS con 422 `ZONA_INVALIDA`.
- **Dos zonas no se superponen.** Si comparten interior, da 409 `ZONAS_SUPERPUESTAS`; tocarse en un borde está permitido.
  - Un `CHECK` no puede mirar otras filas, así que lo controla el repositorio.
  - Todas las escrituras de zonas van en fila, con `pg_advisory_xact_lock`: dos `PUT` simultáneos no pueden dejar dos zonas superpuestas.
- **La zona del origen** sale de `ST_Covers`, que incluye el borde:
  - **origen fuera de toda zona:** 422 `ORIGEN_FUERA_DE_ZONA`, y **no se crea la solicitud**. Ninguna flota opera ahí, y el pasajero se entera en el momento. Se comprueba antes de estimar y de consultar a location;
  - **un punto exacto en un borde compartido:** está en las dos zonas, y gana la de **menor id**. Es una regla determinista, con test;
  - **cambiar el polígono de una zona** no mueve las solicitudes ya creadas: cada una guardó su zona.
- **PostGIS en desarrollo.** Crear la extensión necesita superusuario, y `dispatch_svc` no lo es:
  - en un volumen nuevo la instala el init de Postgres (`infra/postgres/init`), en `dispatch` y `dispatch_test`;
  - en un volumen que ya existía, la instala `npm run setup`;
  - la migración tiene `CREATE EXTENSION IF NOT EXISTS postgis`, que en esos dos casos no hace nada. Sin la extensión, la migración falla con 42501 (sin permiso);
  - en CI y en carga el usuario de la base es superusuario, y la crea la propia migración.

## El filtro de candidatos

location devuelve los choferes con posición vigente más cercanos y no sabe nada de flotas. dispatch los filtra en su base, con una sola consulta por lote (`ElegibilidadPrisma`):

```sql
SELECT d.id FROM drivers d
JOIN fleet_zones fz ON fz.fleet_id = d.fleet_id AND fz.zone_id = $zona
WHERE d.id = ANY($ids) AND d.approved AND d.active AND d.available
  AND NOT EXISTS (SELECT 1 FROM driver_active_assignment a WHERE a.driver_id = d.id)
```

Quedan los habilitados, activos y disponibles, sin un viaje activo, y de una flota con la zona del origen habilitada. Se conserva el orden de location, del más cercano al más lejano.

**Lotes crecientes** (`dominio/casos-uso/buscar-aptos.ts`). Si los más cercanos no sirven, puede haber aptos un poco más lejos:
1. se le pide a location `necesarios + excluidos`, como mínimo 10;
2. se sacan los ya ofrecidos y se filtra;
3. si no alcanzan y el lote vino **completo**, se pide el doble: 10, 20, 40, 80 y 100, el tope por consulta. Son como mucho 5 pedidos;
4. si vino incompleto, no hay más choferes vigentes en el radio: se ofrece a los que quedaron.

Detalles:
- **`completo`** se calcula con la respuesta **original** de location, antes de sacar a nadie. Un lote lleno de ya ofrecidos sigue con el próximo.
- **Las llamadas a location** van fuera de la transacción, como antes.
- **Si falla un pedido**, sube el error de location (503 `UBICACION_NO_DISPONIBLE`): no se crea la solicitud, y en el barrido sigue `BUSCANDO`. Una falla no se confunde con «no hay choferes».
- **El tope agotado:** si los 100 más cercanos no sirven, la solicitud queda `SIN_CHOFERES`, como cuando no hay nadie.
  - Que 100 choferes vigentes y cercanos no sirvan es un problema de datos o de configuración, y seguir buscando no lo arregla.
  - Se cuenta en `dispatch_busquedas_sin_aptos_total{motivo}`: `sin_candidatos`, `filtrados` o `tope_agotado`.
- **El barrido** usa la zona guardada en la solicitud.

## Aceptar: revalidación y la carrera con la flota

Entre la oferta y la aceptación pueden pasar varias cosas: el `admin_flota` desactiva al chofer, el admin lo deshabilita o le quita la zona a su flota, o el chofer deja de estar disponible. Por eso la aceptación vuelve a validar todo **dentro de su transacción**, con locks:

1. `FOR UPDATE` de la solicitud, como siempre.
2. **El chofer, con `FOR SHARE`:** tiene que estar habilitado, activo y disponible. Desactivarlo o deshabilitarlo toma `FOR UPDATE` de esa fila, así que esperan.
3. **La habilitación de la zona en su flota** (la fila de `fleet_zones`), también con `FOR SHARE`. Quitarle la zona a la flota es un `DELETE` de esa fila, y espera.
4. La reserva única del chofer (`driver_active_assignment`) y el resto, sin cambios.
5. Se guarda `fleet_id`, la flota del chofer leída de la fila bloqueada. Si la solicitud no tenía zona, se guarda también `zone_id`.

**Lo que pasa en cada orden** (Postgres en `READ COMMITTED`):
- **Si la otra operación va primero,** la aceptación espera su lock y vuelve a evaluar el `WHERE` con la fila nueva. Ya no es apto: 409 `CHOFER_NO_APTO`, y la oferta y la solicitud quedan como estaban.
- **Si la aceptación va primero,** la otra espera a que confirme:
  - el viaje queda asignado y atribuido a la flota;
  - desactivar con un viaje en curso sigue permitido: libera el cupo, el viaje sigue, y el chofer no recibe más ofertas.

**Orden de los locks:**
- **aceptar:** solicitud → chofer → zona de la flota;
- **desactivar:** chofer → flota;
- **cambiar las zonas de una flota:** flota (con `FOR NO KEY UPDATE`, para no bloquear la clave foránea de `fleet_id`) → zona de la flota.

Nadie los toma al revés, así que no hay ciclo.

**Solicitudes de antes de esta migración** (`zone_id` NULL) se tratan con las reglas nuevas:
- **al aceptar:** se resuelve la zona desde el origen, se revalida al chofer y se guardan la zona y la flota. Si el origen quedó fuera de toda zona, nadie puede aceptarla (409);
- **en el barrido:** se resuelve la zona y se guarda. Fuera de toda zona, no hay candidatos y queda `SIN_CHOFERES`;
- **los viajes históricos,** ya terminados, no se tocan: no se sabe qué flota tenía el chofer entonces.

## El caché de zonas (Redis)

Cada solicitud pregunta en qué zona está el origen (`ST_Covers` en PostGIS) y, en cada lote de candidatos, qué flotas operan en esa zona. Las zonas casi no cambian, así que eso sale de Redis (`infra/zonas/`):

**Qué se cachea:** el **mapa de zonas**: todas las zonas con su polígono y las flotas que tienen cada una habilitada. Sale de una sola consulta a Postgres (`ElegibilidadPrisma.mapaDeZonas`), así que es una foto coherente.

**Para qué se usa** (`ElegibilidadConCache`), solo en la búsqueda previa a la oferta:
- **la zona del origen** se calcula en JavaScript con los polígonos del mapa (rayo horizontal), sin PostGIS;
  - si el punto está a menos de `1e-7` grados (unos 11 mm) de algún lado de alguna zona, decide PostGIS: ahí está la regla del borde (`ST_Covers` y la zona de menor id), y JavaScript y PostGIS podrían no coincidir por redondeo (`ST_AsGeoJSON` devuelve 9 decimales). Lejos de los bordes dan lo mismo;
- **el filtro de candidatos** toma del mapa las flotas de la zona (`d.fleet_id = ANY($flotas)` en vez del `JOIN fleet_zones`). Una zona sin flotas no consulta la base;
  - el estado de cada chofer (habilitado, activo, disponible, sin viaje) **no se cachea**: cambia todo el tiempo y se lee de Postgres, como antes.

**Lo que no usa el caché:** la **aceptación**. Revalida al chofer y la zona de su flota con Postgres, con `FOR SHARE`, dentro de su transacción ([arriba](#aceptar-revalidación-y-la-carrera-con-la-flota)). Un mapa viejo puede hacer que se le ofrezca un viaje a un chofer cuya flota ya perdió la zona, y la aceptación lo rechaza (409 `CHOFER_NO_APTO`); nunca hace que se asigne. Tampoco lo usa la transacción de la aceptación para resolver la zona de una solicitud sin zona.

**Claves** (en el Redis de dispatch):
- `dispatch:zonas:generacion`: un token al azar, sin TTL;
- `dispatch:zonas:mapa:<generacion>`: el mapa en JSON, con TTL `ZONAS_CACHE_TTL_SEGUNDOS` (60 s por defecto; `0` desactiva el caché).

**La invalidación, por generación:**
1. `PUT /admin/zonas/:id` y `PUT /admin/flotas/:id/zonas`, **después del COMMIT** y antes de responder, ponen una generación nueva (`zonasCambiadas`). Lo guardado con la anterior deja de leerse, y el pedido siguiente es un MISS que lee Postgres.
2. Quien lee, lee primero la generación, después Postgres, y guarda lo que leyó con la generación que leyó. Por eso un MISS lento que guarda una foto vieja la guarda con una generación que ya nadie lee: no pisa la nueva.
3. Si la invalidación falla (Redis no responde), el cambio se guarda igual (200) y se avisa en el log. El mapa viejo se usa como mucho el TTL: esa es la red de seguridad, y la aceptación sigue protegida.

**Si Redis falla o tarda** más de 200 ms, se usan las consultas de siempre en Postgres: el caché nunca es un punto de falla ni un 503. Lo que vuelve de Redis se valida: una entrada rota cuenta como MISS.

**Métrica:** `dispatch_zonas_cache_total{resultado}`, con `hit`, `miss` y `error`, como la de tarifas.

**Zonas cambiadas por SQL** (`carga/flotas.sql`, los tests): no pasan por los casos de uso, así que no invalidan. `carga/limpiar.ps1` borra las claves `dispatch:*` antes de aplicar `flotas.sql`; si no, hay que borrar `dispatch:zonas:generacion` o esperar el TTL.

**En memoria** (`DISPATCH_PERSISTENCIA=memoria`) no hay caché: la elegibilidad en memoria ya no consulta a nadie. `cacheZonasMemoria` existe para los tests.

## El reporte de la flota

`GET /flota/reporte?inicio&fin`, para el `admin_flota`, siempre sobre la flota de su token. Lo muestra el panel `/flota` ([docs/web.md](web.md#el-panel-de-la-flota-flota)).

**Qué viajes cuentan:**
- los `COMPLETADA` con `ride_requests.fleet_id` igual al `fleetId` del token: la flota guardada al aceptar, no la actual del chofer (un cambio de flota futuro no reescribe la historia);
- los que tienen `fleet_id` NULL (los de antes de las zonas) **no entran**;
- los demás estados (en curso, cancelados) no cuentan.

**El período:**
- `[inicio, fin)`, instantes ISO 8601 con zona horaria, comparados contra `started_at`, el inicio del viaje;
- `inicio < fin` y como mucho 366 días. Si no, o con una fecha sin zona o una clave extra en la query (por ejemplo `fleetId`), da 400;
- la web manda la medianoche local del «desde» y la del día siguiente al «hasta», así las dos fechas quedan incluidas.

**La facturación:**
- `facturadoCentavos` es la suma de los cobros **`APROBADO`** de esos mismos viajes;
- se agrupa por el período del viaje, no por la fecha del cobro: un cobro que se aprueba después aparece en el período de su viaje al releer;
- los **pendientes** y los **rechazados** se informan aparte (`cobros.pendientes` y `cobros.rechazados`, con cantidad y monto) y no se suman;
- un viaje completado sin cobro (sin tarifa) cuenta como viaje y suma cero.

**Los montos:**
- en Postgres, `SUM(bigint)` es `numeric`: los totales se leen como texto y pasan a `number` solo si son un entero seguro;
- si no lo son, el pedido falla con 500. Nunca se devuelve un monto redondeado (`infra/db/importes.ts`).

**Cómo responde:**
- un período sin viajes da 200 con todo en cero;
- sin `fleetId` en el token, 403 `FLOTA_NO_ASIGNADA`, y con una flota que dispatch no conoce, 404.

**La consulta:** una sola lectura (`LEFT JOIN payments`, con `COUNT` y `SUM … FILTER` por estado), sobre el índice `(fleet_id, status, started_at)` de la migración `20261128000000_reporte_flota`.

## Datos de demo y de carga

- **Demo** (`npm run demo:flotas`, contra el Compose): crea por la API las zonas «CABA» y «Norte».
  - La flota del `admin.flota` opera en CABA, con el chofer del seed habilitado y activo.
  - La del `admin.flota2` opera en Norte.
  - Es idempotente. Si una flota ya existe, no toca su nombre ni su límite.
  - Con `DISPATCH_BUSCADOR=fijo`, la lista fija también pasa por el filtro.
- **Carga** (`carga/flotas.sql`): `carrera.ps1` y `medir.ps1 -Solicitudes` lo aplican después de `limpiar.ps1`.
  - Deja aptos a los 500 choferes de k6 y al de `solicitudes.js`, en una flota de carga con las zonas Buenos Aires y Córdoba.
  - Va por SQL porque carga no tiene identity.

## Rutas

| Ruta | Rol | Qué hace |
|---|---|---|
| `PUT /admin/flotas/:id` `{nombre, maxActivos}` | `admin` | Crea la flota con el id que identity usa como `fleetId`, o cambia su nombre y su límite |
| `PUT /admin/zonas/:id` `{nombre, area}` | `admin` | Crea o cambia una zona (`area`: `Polygon` de GeoJSON). 422 `ZONA_INVALIDA`, 409 `ZONAS_SUPERPUESTAS` |
| `GET /admin/zonas` | `admin` | Las zonas, con su polígono |
| `PUT /admin/flotas/:id/zonas` `{zonas}` | `admin` | Las zonas donde opera la flota (reemplaza las anteriores). 404 si la flota o una zona no existen |
| `POST /admin/choferes/:id/habilitar` y `/deshabilitar` | `admin` | Deshabilitar libera el cupo si estaba activo |
| `GET /flota` | `admin_flota` | Su flota: nombre, límite y activos |
| `GET /flota/choferes?limite&desde` | `admin_flota` | Los choferes de su flota, con `siguiente` para paginar |
| `GET /flota/reporte?inicio&fin` | `admin_flota` | Viajes completados y facturación de su flota en `[inicio, fin)` ([el reporte](#el-reporte-de-la-flota)). Contrato: `ReporteFlotaRespuesta` |
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
- **El reporte:**
  - **contra Postgres** (`tests/integracion/reporte-flota.test.ts`):
    - dos flotas que no ven los viajes ni los cobros de la otra;
    - cobros aprobados, pendientes y rechazados: solo suman los aprobados;
    - un viaje completado sin cobro;
    - un período vacío y los bordes `[inicio, fin)`;
    - quedan fuera los viajes sin flota y los que no están completados;
    - un total grande exacto y uno que pasa 2^53, que da 500;
  - **la validación de la query**, en `tests/seguridad/flotas.test.ts`;
  - **en memoria y la conversión de los totales**, en `tests/dominio/reporte-flota.test.ts`.
- **El adaptador de identity** (`tests/externos/directorio-identity.test.ts`): cada forma de fallar da 503.
- **De punta a punta:** en identity, `tests/integracion/compatibilidad-dispatch.test.ts` levanta el dispatch real y verifica el alta contra el identity real.
- **La ruta interna de identity** (`tests/seguridad/interno.test.ts`).
- **Zonas y filtro, contra PostGIS** (`tests/integracion/zonas.test.ts`):
  - zonas válidas, superpuestas (409), dos `PUT` simultáneos (pasa uno), polígono inválido (422) y validación del cuerpo;
  - dos flotas en zonas distintas: cada origen le ofrece solo a los aptos de la flota de su zona, aunque el de la otra esté más cerca;
  - cada condición del filtro, con su caso: sin habilitar, inactivo, no disponible, con viaje activo y una flota sin la zona;
  - la regla del borde, el origen fuera de zona (422 sin solicitud), y la zona y la flota guardadas al aceptar;
  - una solicitud con `zone_id` NULL.
- **La carrera al aceptar** (`tests/concurrencia/aceptar-vs-flota.test.ts`): contra desactivar y contra quitar la zona, en los dos órdenes, con demoras dentro de cada transacción.
- **Dominio** (`tests/dominio/zonas-busqueda.test.ts` y `zonas-memoria.test.ts`):
  - los lotes crecientes, el lote incompleto que corta, y el tope agotado;
  - el error de location en el segundo pedido, en la creación y en el barrido;
  - `completo` con la respuesta original;
  - la revalidación al aceptar y las solicitudes sin zona;
  - la versión en memoria.
- **El caché de zonas:**
  - **contra PostGIS y Redis** (`tests/integracion/zonas-cache.test.ts`): MISS y después HIT; una entrada rota; crear o mover una zona y quitarle o devolverle la zona a una flota, que el pedido siguiente ya ve; sin la invalidación, el caché queda viejo; Redis que falla (y uno de verdad que no responde), con todo desde Postgres; y la aceptación que no lo usa: con el caché viejo, al chofer le llega la oferta, pero aceptar da 409 `CHOFER_NO_APTO`;
  - **dominio** (`tests/dominio/zonas-cache.test.ts`): la geometría (adentro, afuera, cerca del borde, huecos), HIT, MISS y error, la generación vieja que no se lee, y el aviso de los casos de flotas solo si el cambio confirmó;
  - comprobado que los tests de invalidación fallan si `zonasCambiadas` no invalida.
- **Comprobado que fallan** sin el `FOR SHARE` del chofer, sin el de la zona de la flota, sin el advisory lock de las zonas, y con `completo` calculado después de excluir.

## Lo que sigue

- **Más detalle en el reporte**, si hace falta:
  - el desglose por chofer;
  - exportarlo;
  - facturar por la fecha de aprobación del cobro.
- **Las zonas en la web:** el panel del admin de la plataforma.
- **Borrar zonas:** hoy no se borran. Las solicitudes y las flotas las referencian.
