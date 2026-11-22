# location

> **Estado:** el servicio corre en su contenedor (puerto 3004). Recibe la ubicación de los choferes y responde a dispatch qué choferes están cerca de un origen. Tiene las dos versiones de 6.6: la **ingenua** sobre PostgreSQL, que queda como referencia, y la **optimizada** con Redis GEO e historial en lotes. Se elige con `UBICACION_ESTRATEGIA`. La comparación con k6 está en [docs/mediciones.md](mediciones.md). dispatch lo llama para buscar candidatos (ver [Contrato con dispatch](#contrato-con-dispatch)). Cada posición que recibe la publica en vivo por Redis Pub/Sub, en el canal de su chofer; y la del pasajero, que no se guarda, en el canal del pasajero (ver [Posición en vivo](#posición-en-vivo)).

## Quién es dueño de cada dato

| Dato | Dueño | Por qué |
|---|---|---|
| Posición vigente de cada chofer y su historial | **location** | Es la tarea pesada (500 choferes, un ping cada 2 s). En su propio proceso no le saca event loop a la asignación de viajes |
| Identidad del chofer (`choferId` = `sub` del JWT) | identity | location la toma del token y **nunca del body**: nadie puede informar la posición de otro |
| Habilitado, disponible, viaje activo, flota y zona habilitada | **dispatch** | Los filtra en su propia base. location no sabe nada de viajes ni de flotas |
| Qué choferes ya recibieron una oferta | dispatch | Es estado del viaje. location no necesita esa lista |

## Endpoints

Base local: `http://localhost:3001` es identity; location está en `http://localhost:3004`. Los errores usan el formato único `{error:{code,message,requestId}}`. Los esquemas están en `packages/contracts/src/location.ts`.

### `POST /ubicaciones`, el chofer informa su posición

Lleva `Authorization: Bearer <access token de identity>` y solo lo acepta el rol `chofer`.

```json
{ "lat": -34.6037, "lng": -58.3816 }
```

| Respuesta | Cuándo |
|---|---|
| `204`, sin cuerpo | Guardada, a nombre del chofer del token y con la hora del servidor |
| `400 VALIDACION` | Coordenadas fuera de rango, que no son números, que faltan, o una clave extra: `choferId`, `__proto__`… |
| `401 NO_AUTENTICADO` | Sin token, token inválido o vencido. El token de servicio tampoco sirve acá |
| `403 ROL_NO_PERMITIDO` | El token no es de un chofer |

Está pensado para k6: el camino del ping no hace ninguna lectura, solo valida, inserta y responde. Después de guardar, publica la posición en vivo (ver [Posición en vivo](#posición-en-vivo)); si esa publicación falla, la respuesta sigue siendo `204`.

### `GET /interno/candidatos`, solo para dispatch

Lleva `X-Token-Servicio: <secreto compartido>`. Esta ruta **no se publica por nginx**.

`GET /interno/candidatos?lat=-34.6037&lng=-58.3816&limite=10&radioMetros=5000`

| Parámetro | Valor |
|---|---|
| `lat`, `lng` | Obligatorios, en rango. `0` es válido; un valor vacío no lo es |
| `limite` | 1 a 100. Por defecto, 10 |
| `radioMetros` | 1 a 50 000. Por defecto, 5000 |

```json
{ "candidatos": [ { "choferId": "uuid", "distanciaMetros": 412, "actualizadaEn": "2026-11-19T12:00:00.000Z" } ] }
```

- **Orden y criterio.** Van ordenados de menor a mayor distancia; a igual distancia, por `choferId`. Cuenta solo la **última** posición de cada chofer, y solo si tiene menos de `UBICACION_VIGENCIA_SEGUNDOS` (30 s por defecto). Un chofer que deja de reportar desaparece solo: no hay choferes fantasma.
- **Fin de la lista.** Si vienen **menos que `limite`**, no hay más choferes vigentes dentro del radio.
- **Lista vacía.** No es un error: es «no hay nadie cerca».
- **Errores:** `401 TOKEN_SERVICIO_INVALIDO` sin el encabezado o con un valor distinto, con el mismo mensaje en los dos casos. `400` con parámetros inválidos, repetidos o desconocidos.
- **Token de servicio.** Se compara su SHA-256 en tiempo constante y nunca se loguea ni se devuelve. El JWT de un usuario no abre esta ruta.

### `GET /health` y `GET /ready`

Los de `platform`. `/health` solo dice que el proceso vive; el healthcheck de Docker usa ese.

**Qué informa `/ready` según la estrategia:**

| Situación | Ingenua | Optimizada |
|---|---|---|
| Todo bien | `200`, con `postgres`, `migraciones` | `200`, con `postgres`, `migraciones` y `redis` en `ok` |
| **Postgres caído** | `503 {"estado":"no_listo","chequeos":{"postgres":"<error>","migraciones":"<error>"}}`. Los pings y las búsquedas también fallan | `503` con `postgres` y `migraciones` en error y `redis: ok`. **Los pings siguen entrando (`204`) y la búsqueda funciona**, pero el historial se acumula en Redis hasta que Postgres vuelva |
| Redis caído | `200` (no usa Redis) | `503` con `redis` en error. Pings y búsquedas responden `503 UBICACION_NO_DISPONIBLE`: falla cerrado |
| Migraciones pendientes | `503` con `migraciones pendientes: …` | igual |

En la optimizada, un `503` por Postgres no significa que el servicio esté parado: significa «el historial no se está escribiendo». Conviene alertar, porque la cola tiene un tope (ver [Cola llena](#cola-llena)).

### `GET /metrics`

Lo monta `platform`, igual en los tres servicios: `Authorization: Bearer <METRICAS_TOKEN>`. Sin el encabezado o con otro valor, `401 TOKEN_METRICAS_INVALIDO`. El token de servicio **no** sirve acá: cada secreto abre una sola cosa. Formato de texto de Prometheus; todas las series llevan `servicio="location"`:

| Métrica | Qué es |
|---|---|
| `event_loop_lag_ms{quantile="0.5"\|"0.99"}`, `event_loop_lag_max_ms`, `event_loop_lag_mean_ms` | Lag del event loop desde el arranque, con `monitorEventLoopDelay` (resolución de 10 ms, ya descontada). Hasta el 20/11 se llamaba `location_event_loop_lag_*`, sin `servicio`: `carga/resumir.mjs` lee los dos formatos |
| `process_resident_memory_bytes`, `nodejs_heap_used_bytes` | Memoria |
| `http_request_duration_seconds{metodo, ruta, estado}` | Histograma de duración por ruta (el patrón, nunca la URL con ids; `sin_ruta` si ningún handler atendió el pedido) |
| `location_estrategia{estrategia}` | Estrategia con la que corre (siempre 1) |
| `location_historial_en_cola`, `location_historial_pendientes` | Optimizada: entradas en el stream y entradas leídas sin confirmar. `carga/medir.ps1` las usa para esperar el drenaje y **falla si no las encuentra** |
| `location_historial_descartados_total`, `location_historial_ocupacion`, `location_historial_max_cola` | Optimizada: entradas que no entraron por cola llena, uso de la cola (de 0 a 1) y su tope |
| `location_posiciones_publicadas_total{de, resultado}` | Publicaciones de la posición en vivo, del chofer o del pasajero (`de`): `publicada`, `atrasada` (más vieja que la última publicada), `vencida` (superaba la vigencia) o `error` (falló o no se confirmó en 200 ms) |

## Versión optimizada (`UBICACION_ESTRATEGIA=optimizada`)

Necesita `REDIS_URL` además de `LOCATION_DATABASE_URL`. Implementa el mismo puerto que la ingenua (`RepositorioUbicaciones`), así que las rutas, el contrato y los casos de uso no cambian.

**Qué guarda en Redis** (prefijo `LOCATION_REDIS_PREFIJO`, por defecto `location:`):

| Clave | Tipo | Para qué |
|---|---|---|
| `location:pos` | HASH `choferId → "lat\|lng\|tsMs"` | Última posición con las coordenadas **originales**: con estas se calcula la distancia |
| `location:geo` | GEO | Índice para encontrar los candidatos del radio. Sus coordenadas vienen cuantizadas: no se usan para la distancia |
| `location:visto` | ZSET `choferId → tsMs` | Vencimiento y purga |
| `location:fuera-geo` | SET | Choferes con latitud fuera de ±85,05112878°, que Redis GEO no acepta. Normalmente vacío |
| `location:historial` | STREAM | Pings pendientes de escribir en Postgres |
| `location:historial:descartados` | contador | Pings que no entraron al historial por cola llena |

**Un ping.** Un script Lua escribe todo junto, de forma atómica:
- si es más nuevo que la posición guardada, actualiza `pos`, `geo` (o `fuera-geo`) y `visto`; un ping más viejo que llega tarde no la pisa;
- además, lo encola en el stream del historial.

No toca Postgres.

**Una búsqueda.**
1. `GEOSEARCH` con un radio de `radio × 1,001 + 1 m` trae los candidatos. Se suman los de `fuera-geo` y, si el origen está fuera de ±85,05°, se evalúan todas las posiciones.
2. Se descartan las vencidas, aunque la purga todavía no haya pasado.
3. La distancia exacta, el radio, el orden y el desempate los resuelve **el dominio**, con las coordenadas originales: la misma función que usan la ingenua y la de memoria.

**Por qué ese margen.** Redis mide sobre una esfera de 6 372 797,6 m y el dominio, sobre una de 6 371 008,8 m: las distancias de Redis son un 0,028 % más largas. Además, cada punto se guarda como un geohash de 52 bits, con hasta ~0,34 m de error. El margen cubre unas 3,5 veces lo primero y 3 veces lo segundo; lo que entra de más lo descarta el dominio. Hay tests que fallan si se quita el margen.

**Purga.** Cada `LOCATION_PURGA_INTERVALO_MS` (10 s) un script Lua borra de las cuatro estructuras a los choferes vencidos, para que el índice no crezca sin límite.

**Historial: cola y escritura en lotes.**
- Un consumidor dentro del mismo proceso lee el stream con su **propia conexión** a Redis (`XREADGROUP BLOCK`), de a `LOCATION_HISTORIAL_LOTE` entradas (500).
- Escribe cada lote con un solo `INSERT` (`createMany`) en la misma tabla `pings`, y después confirma (`XACK`) y borra (`XDEL`).
- **Sin duplicados:** cada fila guarda el id de su entrada del stream en `stream_id`, que es único, y el `INSERT` usa `skipDuplicates`. Si un lote se escribió pero no se llegó a confirmar, reescribirlo no duplica.
- **Si Postgres falla:** no confirma nada; las entradas quedan pendientes y se reintentan con espera creciente, hasta 5 s.
- **Recuperación durante la ejecución:** antes de leer nuevas, cada vuelta reintenta **sus propios pendientes**. Cada `LOCATION_HISTORIAL_RECLAMO_MS` (30 s) hace `XAUTOCLAIM` de lo que otro consumidor dejó sin confirmar más de 30 s, por ejemplo una instancia que murió. No hace falta reiniciar nada.

<a id="cola-llena"></a>
**Cola llena.** El stream tiene un tope de `LOCATION_HISTORIAL_MAX` entradas (500 000, unos 33 minutos de pings a 250 por segundo sin Postgres).
- Al llegar al tope, **la posición vigente se sigue actualizando**: el servicio no se corta. La entrada **no** se encola y se suma al contador `historial:descartados`.
- No se recortan entradas viejas, porque pueden estar pendientes.
- **Cómo se detecta:**
  - en `/metrics` (`location_historial_ocupacion` y `location_historial_descartados_total`);
  - en el log, con un aviso al pasar el 80 % y un error, como máximo una vez por minuto, mientras haya descartes;
  - `/ready` ya estaba en `503` si la causa es Postgres.

**Qué queda en Redis después de un apagado.** Con SIGTERM, location deja de recibir pedidos, termina la vuelta en curso y vacía lo que pueda del historial (hasta 5 s), y recién después cierra Redis y Postgres. Lo que no alcance a escribir queda en Redis:

| Qué queda | Qué pasa al volver a arrancar |
|---|---|
| Las posiciones (`pos`, `geo`, `visto`, `fuera-geo`) | Siguen sirviendo para buscar mientras estén vigentes (30 s). Las vencidas no aparecen y las borra la próxima purga |
| Entradas del stream **sin leer** | Las lee la nueva instancia apenas arranca |
| Entradas **leídas y sin confirmar** (el proceso murió a mitad de un lote) | Quedan pendientes a nombre de la instancia anterior. La nueva las reclama con `XAUTOCLAIM` después de 30 s de inactividad y las escribe sin duplicar (`stream_id`) |
| El contador de descartados | Se conserva: es acumulado |

Si se pierde el propio Redis (sin persistencia), se pierden las posiciones, que se reponen solas con los pings siguientes, y el historial que todavía no se había escrito.

## Versión ingenua (`UBICACION_ESTRATEGIA=ingenua`)

Es la línea de base que pide 6.6 para medir con k6:

- **Pings.** Cada ping es un `INSERT` en `pings(driver_id, lat, lng, recorded_at)`, aunque el chofer mande uno cada 2 s. Es también el historial.
- **Búsqueda.** Trae la última posición de **todos** los choferes vigentes (`DISTINCT ON (driver_id)`, que usa el índice `(driver_id, recorded_at DESC)`). Después calcula la distancia (haversine) y ordena **en JavaScript**, dentro del event loop. No hay índice geográfico.
- **Estrategia `memoria`.** Sirve para los tests y para correr sin base.
- **Su cuello de botella.** Bajo carga, cada `INSERT` espera el `fsync` de su propio commit (`WALWrite`/`WALSync`). Los `INSERT` ocupan el pool de conexiones y las búsquedas esperan detrás. Ver [docs/mediciones.md](mediciones.md).

## Posición en vivo

Cada ping que se guarda se publica por **Redis Pub/Sub** en el canal de su chofer. dispatch es quien sabe qué viaje tiene cada chofer: se suscribe al canal del chofer asignado mientras el viaje está activo y reenvía la posición por SSE solo a ese pasajero (la regla de privacidad se aplica ahí, ver [docs/eventos.md](eventos.md)). Funciona con las dos estrategias de 6.6: Compose corre la ingenua.

**Canal:** `<LOCATION_REDIS_PREFIJO>posicion:<choferId>`, por ejemplo `location:posicion:00000000-0000-4000-8000-000000000002`; en el entorno de k6, `carga:location:posicion:<choferId>`. Lo arma `canalPosicionChofer(prefijo, choferId)` de `packages/contracts/src/location.ts`. El prefijo hace falta porque Pub/Sub no separa por número de base: sin él, los tests (base 14) y el desarrollo (base 0) compartirían canales.

**Payload** (`PosicionChoferPublicada`, en el mismo archivo):

```json
{ "tipo": "DriverLocationUpdated", "choferId": "uuid", "lat": -34.6001, "lng": -58.3816, "actualizadaEn": "2026-11-21T12:00:00.000Z" }
```

- `actualizadaEn` es la hora del servidor al recibir el ping, como en `Candidato`.
- Es **efímero**: sin `seq`, no se guarda y no se repone. Quien se suscribe recibe la próxima posición (llega en ~2 s).
- Para dispatch: `SUBSCRIBE` al canal de cada chofer, **no** `PSUBSCRIBE location:posicion:*`. Con un patrón, cada `PUBLISH` (250 por segundo con el simulador) se compara contra él y cada instancia de dispatch recibe las posiciones de todos los choferes.

**Cuándo se publica** (`registrarUbicacion`, igual para todas las estrategias):

1. Se guarda el ping. Si el guardado falla, responde el error y **no se publica nada**.
2. Si el ping ya superó `UBICACION_VIGENCIA_SEGUNDOS` al momento de publicar (por ejemplo, un guardado que tardó), no se publica: es la misma regla con la que la búsqueda descarta a los fantasmas. Se cuenta como `vencida`.
3. Un script Lua del publicador (`infra/redis/publicador-posiciones.ts`) compara la hora del ping con la **marca de la última publicada** de ese chofer (`<prefijo>publicada:<choferId>`). Si el ping es más viejo, no publica (`atrasada`). Si no, actualiza la marca y publica, todo de forma atómica. A igual milisegundo publica, como el guardado.

**La garantía, con precisión:**

- **Orden por timestamp respecto de la última publicación, mientras exista su marca.** En cada canal, `actualizadaEn` no retrocede: dos pedidos del mismo chofer que se cruzan (o dos instancias de location) no pueden anunciar una posición vieja después de una nueva. Hace falta porque la hora la pone el servidor al entrar el pedido, pero el `INSERT` o el Lua de un pedido pueden terminar después que los del siguiente.
- **La marca dura 2 × la vigencia** (60 s) y no necesita purga. Si ya venció, un ping más viejo que el último publicado igual se descarta: para entonces está vencido (paso 2).
- **Si falla una publicación, el canal puede quedar atrasado respecto del repositorio**: la posición guardada es más nueva que la última anunciada, hasta que se publique el próximo ping. No se reintenta.
- Supone el mismo reloj en todas las instancias de location (en Compose comparten el host).

**Si falla la publicación, el ping no se compromete:**

- Responde **`204`** igual: la posición ya quedó guardada. El caso de uso atrapa el error.
- El publicador usa su **propia conexión** a Redis, separada de la que guarda las posiciones, con:
  - `commandTimeout` de **200 ms**: es lo máximo que el `204` espera a la publicación. **Un timeout significa que faltó la confirmación dentro del plazo, no que no se publicó**: el comando pudo ejecutarse igual (hay un test que lo muestra);
  - `enableOfflineQueue: false`: sin conexión lista (caída o reconectando), falla en el momento, sin acumular comandos para mandarlos al reconectar ni esperar hasta el timeout en cada ping. (En ioredis 6, lo que vence en la cola tampoco se manda después; lo que cambia es la espera, y no depende de ese detalle);
  - `maxRetriesPerRequest: 0` y `autoResendUnfulfilledCommands: false`: lo que se mandó y quedó sin respuesta antes de un corte falla en el corte y no se reenvía al reconectar. Una posición mandada tarde sería ruido. Con `maxRetriesPerRequest: 0`, ioredis ya rechaza todo lo pendiente en el corte, así que la segunda opción es redundante hoy: deja explícita la intención si alguien sube los reintentos. El test falla si se quitan las dos.
- Se cuenta en `location_posiciones_publicadas_total{de="chofer",resultado="error"}` y se avisa en el log como mucho una vez por minuto, con cuántas fallaron.
- `/ready` no cambia: sin Redis, la ingenua sigue registrando pings; lo único que se cae es el seguimiento. En la optimizada, sin Redis ya fallan los pings (`503`), como antes.
- Sin `REDIS_URL` (estrategia `memoria`), no hay publicador y el log lo avisa al arrancar.

### La posición del pasajero (para el chofer asignado)

El sentido inverso: el pasajero informa su posición y el chofer asignado a su viaje la ve. location publica; **dispatch decide la entrega**: solo el chofer asignado al viaje activo de ese pasajero (`ASIGNADO`, `EN_CAMINO` o `EN_CURSO`) la recibe. location no sabe de viajes.

**`POST /ubicaciones/pasajero`**, solo el rol `pasajero`, con el mismo cuerpo que el chofer (`{lat, lng}`, `strictObject`):

| Respuesta | Cuándo |
|---|---|
| `204` | Publicada, o descartada por atrasada o vencida |
| `400 VALIDACION` | Coordenadas inválidas o una clave extra (`pasajeroId`, `choferId`…): el pasajero sale del token |
| `401` / `403 ROL_NO_PERMITIDO` | Sin token, o el token no es de un pasajero |
| `503 POSICION_NO_PUBLICADA` | Sin Redis, Redis caído o sin confirmación en 200 ms. Publicar es el único efecto: no hay nada guardado que proteger, y el cliente manda la siguiente en unos segundos |

- **Efímera:** es una ruta aparte que **no pasa por el repositorio**. No toca `pings`, ni `pos`, `geo` o `visto`, ni el stream del historial, y nunca aparece en `/interno/candidatos`. Lo único que queda en Redis es la marca de orden, que vence sola.
- **Canal:** `<LOCATION_REDIS_PREFIJO>posicion-pasajero:<pasajeroId>` (`canalPosicionPasajero` en `contracts`). Es un espacio de nombres distinto del de los choferes: ni un `SUBSCRIBE` ni un patrón de uno toca al otro.
- **Payload** (`PosicionPasajeroPublicada`):
  ```json
  { "tipo": "PassengerLocationUpdated", "pasajeroId": "uuid", "lat": -34.6001, "lng": -58.3816, "actualizadaEn": "2026-11-22T12:00:00.000Z" }
  ```
  Con el `tipo` distinto, el payload del pasajero no pasa `PosicionChoferPublicada`, y al revés.
- **Lo que se reutiliza del chofer:** la misma conexión (200 ms, sin cola offline, sin reenvío), el mismo script Lua de orden con su propia marca (`<prefijo>publicada-pasajero:<id>`, 2 × la vigencia), el descarte por vigencia y la métrica `location_posiciones_publicadas_total{de="pasajero"}`.
- **Tests** (`tests/integracion/publicacion-pasajero.test.ts`, con Redis real y en las dos estrategias):
  - permisos y el id del token;
  - que se publique en el canal correcto, sin guardarse ni entrar en candidatos;
  - 503 con el Redis del publicador caído, sin confirmación o sin publicador.

  El orden lo cubren las pruebas del Lua del chofer, porque el script es el mismo.

**Costo medido** (21/11, corrida corta con k6: optimizada, 250 pings/s, 10 s de calentamiento y 60 s de medición, dos corridas alternadas contra `main` sin publicación, en la misma máquina):

| | Sin publicación (`main`) | Con publicación |
|---|---|---|
| Pings/s logrados | 250,0 y 250,0 | 250,0 y 250,0 |
| Errores | 0 % | 0 % |
| Ping p95 (ms) | 3,4 y 4,1 | 6,4 y 6,9 |
| Ping p99 (ms) | 18,2 y 27,5 | 43,9 y 45,3 |
| CPU de location (promedio) | 44 % y 52 % | 57 % y 57 % |

El `204` espera una operación más en Redis: el p95 sube unos 3 ms y el p99 se duplica, sin errores ni pings omitidos. Son corridas de 60 s; para el informe hay que repetirlas con la medición completa de 5 min.

**Tests** (`tests/dominio/publicacion.test.ts`, `tests/integracion/publicacion.test.ts`, con Redis real):

- el mensaje sale en el canal del chofer del token, con el payload del contrato, en las dos estrategias; el canal de otro chofer no recibe nada;
- si el guardado falla, no se publica;
- un ping atrasado que termina de guardarse después de uno nuevo no se anuncia, y lo publicado coincide con la posición vigente;
- 50 pings del mismo chofer cruzados con demoras al azar: lo que llega al canal nunca retrocede;
- sin marca y con un ping ya vencido, no se publica; con la marca vencida, un ping más viejo que el último publicado se descarta por vencido;
- falla **solo el publicador** (un proxy TCP delante de su conexión) en la optimizada: con su Redis caído, `204` enseguida y nada se publica tarde al volver; reconectando con el handshake sin terminar, falla en el momento (no espera ni encola); sin respuesta, `204` a los 200 ms aunque la publicación ocurrió; lo pendiente antes de un corte no se reenvía. En todos los casos la posición queda guardada y se cuenta el error.

Comprobado que fallan sin la comparación con la marca, sin guardarla, sin el descarte por vencida, sin aislar la falla, publicando antes de guardar, con cola offline, sin `commandTimeout`, sin `maxRetriesPerRequest: 0` y `autoResendUnfulfilledCommands: false` (las dos juntas) y sin el límite del log.

## Contrato con dispatch

dispatch llama a `GET /interno/candidatos` desde el adaptador `BuscadorCandidatosLocation` (`services/dispatch/src/infra/externos/buscador-location.ts`), que implementa el puerto `BuscadorCandidatos.buscar(origen, { excluir, limite })`. Lo usa **fuera de la transacción**, al crear la solicitud y en el barrido de ofertas vencidas. El cliente HTTP es el de `platform` (`crearClienteInterno`): timeout siempre y respuesta validada con `CandidatosRespuesta`.

**Decidido e implementado:**

1. **Token de servicio:** secreto compartido en `X-Token-Servicio`, con la misma variable `LOCATION_TOKEN_SERVICIO` en los dos servicios. Un JWT de servicio emitido por identity sumaba un rol nuevo y cambios en identity sin una ganancia que hoy haga falta.
2. **Timeout:** 1 s (`LOCATION_TIMEOUT_MS`). Radio de búsqueda: 5 km (`DISPATCH_RADIO_BUSQUEDA_METROS`).
3. **Si location no responde** (timeout, error de red, 5xx, 4xx o respuesta fuera de contrato):
   - `POST /solicitudes` responde `503 UBICACION_NO_DISPONIBLE` y **no crea el viaje** ni escribe eventos. Falla cerrado, y como la búsqueda va antes de la transacción, no queda nada a medias.
   - El barrido **no** marca `SIN_CHOFERES`: registra el error y reintenta en la pasada siguiente. Mientras tanto, la oferta vencida no se puede aceptar, porque el vencimiento se decide con el reloj.
   - Un 4xx de location es un error de programación en dispatch (token o contrato mal configurado): se loguea como `error`, no como `warn`, y también da 503.
   - location **no** está en el `/ready` de dispatch: con location caído, el login, las consultas y las aceptaciones siguen andando.
4. **`excluir`:** lo resuelve dispatch. Pide `limite + excluidos` (mínimo 10, máximo 100) y saca a los ya ofrecidos. Con solo ese filtro, un lote completo siempre deja `limite` aptos, así que alcanza con un pedido.
5. **Para demos sin location**, `DISPATCH_BUSCADOR=fijo` vuelve a la lista de `DISPATCH_CANDIDATOS_DEMO`.

Tests: `services/dispatch/tests/externos/buscador-location.test.ts` (contra un location falso: pedido, orden, excluidos y cada forma de fallar) y `tests/integracion/location.test.ts` (dispatch completo con Postgres: 201 con ofertas, 503 sin viaje creado, `/ready` y el barrido).

### Pendiente para cuando dispatch filtre por flota y zona: lotes crecientes

Cuando entre el filtro de Agos (disponibilidad, viaje activo, flota y zona), puede pasar que los N más cercanos no sirvan aunque haya choferes aptos un poco más lejos. Con un solo lote, dispatch marcaría `SIN_CHOFERES` de más. La propuesta, sin cambiar el contrato:

1. Pedir `limite = necesarios + excluidos`, con un mínimo de 10.
2. Filtrar en dispatch: excluidos, no disponibles, con viaje activo, de otra flota o zona.
3. Si quedan suficientes, ofrecer.
4. Si no alcanzan y location devolvió el lote **completo** (tantos como `limite`), puede haber más: pedir de nuevo con el doble de `limite`, hasta el máximo de 100.
5. Si location devolvió **menos** que `limite`, no hay más vigentes en el radio: se ofrece a los que quedaron y, si no queda ninguno, `SIN_CHOFERES`.

Son como máximo 5 pedidos (10, 20, 40, 80 y 100). Si el filtro de flota y zona se vuelve el cuello de botella, la mejora sería mandarle a location la zona del origen: eso sí cambia el contrato.

### Pendiente: el tope por consulta y qué pasa si se agota

**El tope.** location devuelve como máximo **100 candidatos por consulta** (`LIMITE_CANDIDATOS_MAX` en `packages/contracts/src/location.ts`) y busca en un radio máximo de 50 km.

- Acota la respuesta y el trabajo por pedido, para que una consulta no pueda pedir los 500 choferes del simulador.
- En la versión ingenua el costo casi no depende del tope, porque igual recorre todas las posiciones vigentes. En la optimizada, `GEOSEARCH` trae todos los choferes del radio (sin `COUNT`) y el dominio corta en `limite`: el costo crece con los choferes que haya en el radio, no con el tope.
- Con `OFERTAS_SIMULTANEAS=3`, 100 alcanza de sobra mientras el único filtro sea `excluir`.

**El caso borde.** Con el filtro de flota y zona, dispatch podría pedir los 100 más cercanos y descartarlos **a todos**. Puede haber choferes aptos más lejos, pero location no puede devolverlos sin cambiar el contrato.

**Qué hace dispatch hoy:** `ofrecerACandidatos` recibe una lista vacía y pasa la solicitud a `SIN_CHOFERES` en ese mismo momento.

**Propuesta, la más simple:** mantener ese comportamiento también en este caso.

- Que 100 choferes vigentes y cercanos sean todos no aptos indica un problema de datos o de configuración de flotas y zonas, no un faltante de choferes. Insistir no lo arregla.
- dispatch lo registra en el log con un motivo propio (`tope_agotado`, distinto de «location no devolvió nadie»), con la cantidad descartada por cada filtro.
- El pasajero recibe la misma respuesta que con `SIN_CHOFERES` y puede volver a pedir.

**Alternativas:**

- **Seguir buscando:** dejar la solicitud en `BUSCANDO` y que el barrido reintente hasta un plazo, por ejemplo 60 s desde la creación. Cambia el dominio de dispatch, porque hoy una tanda vacía termina la búsqueda.
- **Filtrar en location:** mandar la zona del origen o la flota en la consulta. Cambia el contrato y le hace saber a location de flotas, que hoy no conoce.

Se decide junto con el filtro de flota y zona (Agos e Iván).

## Levantarlo desde PowerShell

Requisitos: lo de [docs/identity.md](identity.md#levantarlo-desde-powershell) (Docker, `.env`, `npm ci`, clave de identity y seed). Todos los comandos van desde la raíz del repo.

### Primera vez

> **Lo más corto:** `npm run setup` hace todos los pasos de esta sección (`.env`, clave, bases que falten, migraciones y seed) y `npm run dev` levanta los tres servicios; ver el [README](../README.md#levantar-el-sistema). Los pasos de abajo sirven para entender qué hace o para hacerlo a mano.

1. Si tu `.env` es anterior a location, agregale la sección `location` de `.env.example`. `LOCATION_TOKEN_SERVICIO` de ese archivo es **solo para desarrollo**; en cualquier entorno publicado va uno aleatorio.

2. Creá `location_test` **sin borrar datos**. El script de init solo corre con el volumen vacío, así que si tu Postgres ya estaba inicializado no la creó. La base `location` y el usuario `location_svc` ya existen, porque los crea el mismo script. Este comando es idempotente: si la base ya existe, no hace nada.

```powershell
npm run infra:up
"SELECT 'CREATE DATABASE location_test OWNER location_svc' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'location_test')\gexec" | docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1
docker compose exec -T postgres psql -U postgres -c "REVOKE ALL ON DATABASE location_test FROM PUBLIC"
```

   En un volumen nuevo, el script de init ya crea las dos bases. **No hace falta `docker compose down -v`**, que borraría todos los datos.

3. Generá el cliente de Prisma y migrá la base de desarrollo de location:

```powershell
npm run prisma:generate -w @viajes/location
npm run local -- location migrate:deploy
```

### Correr el servicio

Para la prueba manual hacen falta identity y location, cada uno en su propia terminal:

```powershell
npm run local -- identity
```

```powershell
npm run local -- location
```

`npm run local` carga `.env` en un proceso aparte y fija el puerto: location siempre en 3004.

**Con Docker** (sin la prueba manual, porque dentro del Compose el JWKS se busca en el contenedor `identity`):

```powershell
docker compose up -d --build --no-deps location
Invoke-RestMethod http://localhost:3004/ready | ConvertTo-Json -Compress
docker compose stop location
```

Esperado: `{"estado":"listo","chequeos":{"postgres":"ok","migraciones":"ok"}}`. Si dice `migraciones pendientes`, falta el paso 3.

## Prueba manual

En una tercera terminal, desde la raíz del repo. Los bloques comparten variables. Solo se muestran códigos HTTP y datos públicos: ningún token ni contraseña.

**1. Preparar**

```powershell
$identity = 'http://localhost:3001'
$location = 'http://localhost:3004'
$contrasena = (Select-String -Path .env -Pattern '^IDENTITY_SEED_CONTRASENA=(.*)$').Matches[0].Groups[1].Value
$conServicio = @{ 'X-Token-Servicio' = (Select-String -Path .env -Pattern '^LOCATION_TOKEN_SERVICIO=(.*)$').Matches[0].Groups[1].Value }
function Entrar($email) {
  $body = @{ email = $email; contrasena = $contrasena } | ConvertTo-Json
  Invoke-RestMethod -Method Post "$identity/login" -ContentType 'application/json' -Body $body
}
function Estado([scriptblock]$pedido) {
  try { $r = & $pedido; "HTTP $([int]$r.StatusCode)" } catch { "HTTP $([int]$_.Exception.Response.StatusCode)" }
}
function Informar($cabeceras, $cuerpo) {
  Invoke-WebRequest -UseBasicParsing -Method Post "$location/ubicaciones" -ContentType 'application/json' -Headers $cabeceras -Body $cuerpo
}
Invoke-RestMethod "$location/ready" | ConvertTo-Json -Compress
```

Esperado: `"estado":"listo"`.

**2. El chofer informa su posición**

Un punto unos 400 m al norte del Obelisco:

```powershell
$chofer = Entrar 'chofer@viajes.test'
$conChofer = @{ Authorization = "Bearer $($chofer.token)" }
Estado { Informar $conChofer (@{ lat = -34.6001; lng = -58.3816 } | ConvertTo-Json) }
```

Esperado: `HTTP 204`.

**3. dispatch pregunta quién está cerca del Obelisco**

```powershell
(Invoke-RestMethod "$location/interno/candidatos?lat=-34.6037&lng=-58.3816&limite=5" -Headers $conServicio).candidatos | Format-List
```

Esperado: el chofer de prueba (`00000000-0000-4000-8000-000000000002`) con `distanciaMetros` cerca de 400.

**4. Rechazos**

```powershell
$pasajero = Entrar 'pasajero@viajes.test'
$posicion = @{ lat = -34.6; lng = -58.38 } | ConvertTo-Json
# Un pasajero no informa ubicación: 403
Estado { Informar @{ Authorization = "Bearer $($pasajero.token)" } $posicion }
# Nadie informa la posición de otro chofer: 400
Estado { Informar $conChofer (@{ lat = -34.6; lng = -58.38; choferId = '00000000-0000-4000-8000-000000000099' } | ConvertTo-Json) }
# La ruta interna sin token de servicio: 401
Estado { Invoke-WebRequest -UseBasicParsing "$location/interno/candidatos?lat=-34.6&lng=-58.38" }
# Tampoco con el token de un usuario: 401
Estado { Invoke-WebRequest -UseBasicParsing "$location/interno/candidatos?lat=-34.6&lng=-58.38" -Headers $conChofer }
# Coordenada imposible: 400
Estado { Informar $conChofer (@{ lat = 95; lng = 0 } | ConvertTo-Json) }
```

Esperado: `HTTP 403`, `HTTP 400`, `HTTP 401`, `HTTP 401` y `HTTP 400`.

**5. El chofer fantasma desaparece**

Opcional, tarda 30 segundos:

```powershell
Start-Sleep -Seconds 31
(Invoke-RestMethod "$location/interno/candidatos?lat=-34.6037&lng=-58.3816" -Headers $conServicio).candidatos.Count
```

Esperado: `0`, porque el chofer dejó de reportar hace más de `UBICACION_VIGENCIA_SEGUNDOS`.

## Tests

```powershell
npm test -w @viajes/location
npm run test:dominio -w @viajes/location
```

- `test:dominio` no necesita Docker.
- `npm test` usa la base `location_test` (ver [Primera vez](#primera-vez)) y la base 14 de Redis (`LOCATION_REDIS_URL_TEST`), con un prefijo propio por suite.
- **Mismas reglas para las tres estrategias:** `tests/soporte/casos-compartidos.ts` corre contra memoria, ingenua y optimizada.
- **Equivalencia** (`tests/integracion/equivalencia.test.ts`):
  - 300 choferes y 200 búsquedas generados con una semilla fija dan resultados idénticos en las tres: ids, orden, distancias y fechas;
  - también el borde del radio (r − 0,5, r − 0,3, r + 0,3 y r + 0,9 m), los empates y las diferencias de centímetros;
  - y las latitudes polares y el antimeridiano.
- **Historial** (`tests/integracion/historial.test.ts`):
  - Postgres cae y vuelve, y no quedan duplicados;
  - la escritura sale bien y falla la confirmación;
  - una instancia muere con entradas pendientes y otra las recupera;
  - el apagado vacía la cola;
  - la cola llena se detecta.

## Lo que sigue

1. **Medir de punta a punta** con dispatch integrado: tiempo hasta la asignación que pide 6.6 (con la hipótesis escrita antes) y lag del event loop de dispatch mientras corre el simulador. Lotes crecientes cuando entre el filtro de flota y zona.
2. **Después:**
   - límite de pedidos en `/ubicaciones`;
   - retención del historial;
   - ~~publicación por Redis para el seguimiento~~ (hecho, ver [Posición en vivo](#posición-en-vivo)); la regla de privacidad la aplica dispatch al suscribirse;
   - Alloy y los dashboards de Grafana sobre el `/metrics` de `platform` (ya hecho);
   - ADR 0008 (Redis GEO frente a PostGIS frente a geohash), con los números de [docs/mediciones.md](mediciones.md).
