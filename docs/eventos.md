# Eventos y tiempo real (dispatch)

Reescrito para el [plan v2](../PLAN.md) (sección 3.5): sin RabbitMQ. Los eventos de dispatch se guardan en su `outbox`, un relay los publica en Redis Pub/Sub y el pasajero y el chofer los reciben por **Server-Sent Events** en `GET /eventos`. Por qué SSE y no WebSocket ni polling: [ADR 0007](adr/0007-tiempo-real-sse.md).

```
caso de uso ──(misma transacción)──▶ outbox ──relay cada 100 ms──▶ Redis Pub/Sub ──▶ GET /eventos (SSE)
                                       │      FOR UPDATE SKIP LOCKED   un canal por usuario     │
                                       └──────────── reposición con Last-Event-ID ◀──────────────┘
```

## Outbox: no perder eventos

El código ingenuo hace `COMMIT` y después publica. Si el proceso muere en el medio, el evento se pierde. Publicar antes tampoco sirve: se anunciaría algo que después hace rollback.

Por eso cada caso de uso escribe el evento en la tabla `outbox` **en la misma transacción** que el cambio de estado (`tx.registrarEvento`). Cada fila guarda:
- `seq`: un número que crece con cada evento. Es el `id:` del evento en el stream SSE;
- `recipients`: a quién se le entrega. Son el pasajero y el chofer que figuran en el payload, y nadie más.

## Relay: publicar lo nuevo

Cada `RELAY_INTERVALO_MS` (100 ms; es la demora máxima de un evento), en una transacción (`infra/tiempo-real/outbox-prisma.ts`):
1. toma un lote de eventos sin publicar, en orden de `seq`, con `FOR UPDATE SKIP LOCKED`;
2. los publica en Redis, en el canal de cada destinatario (`dispatch:eventos:<usuarioId>`);
3. los marca publicados (`published_at`) y confirma.

- **Varias instancias de dispatch:** con `SKIP LOCKED` cada relay toma filas distintas, sin esperar al otro. Test: cuatro relays a la vez sobre 300 eventos publican cada uno exactamente una vez. Comprobado que falla sin el lock.
- **Al menos una vez:** si el proceso muere entre publicar y confirmar, el lote se vuelve a publicar. El stream descarta los repetidos (ver abajo).
- **Si Redis falla,** no se marca nada y el próximo ciclo reintenta.

## `GET /eventos` (SSE)

**Pedido:**
- `Authorization: Bearer <access token>`, rol `pasajero` o `chofer`. Operador y admin de flota: 403.
- Opcional: `Last-Event-ID: <seq>`, el `id` del último evento recibido. Si no es un número, 400 `LAST_EVENT_ID_INVALIDO`.
- No hay parámetros: el usuario sale del token y nadie puede pedir los eventos de otro.

**El cliente:** `EventSource` no permite mandar encabezados, y el token no va en la URL porque quedaría en los logs de nginx. El frontend usa `fetch` con el `Authorization` y lee el cuerpo como stream (`apps/web/src/tiempo-real/`, ver [docs/web.md](web.md#lo-compartido-entre-las-pantallas-de-viaje)). Al reconectar pide el estado actual: el stream avisa de los cambios, pero la fuente de verdad sigue siendo la base. La pantalla del chofer relee `GET /chofer/estado` (su viaje activo y sus ofertas pendientes) al conectar y con cada evento, así que no necesita `Last-Event-ID`. El pasajero puede usar `GET /solicitudes/:id`.

**Respuesta:** `200`, `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform` y `X-Accel-Buffering: no` (para que nginx no junte los eventos en su buffer). Detrás del contenedor `web`, la ruta es `/api/viajes/eventos`, sin buffer y con un `proxy_read_timeout` de 60 s, mayor que el latido ([docs/web.md](web.md#sse)).

```
retry: 3000

id: 1042
event: TripAssigned
data: {"solicitudId":"…","pasajeroId":"…","choferId":"…","origen":{…},"destino":{…}}

: latido
```

**Cómo funciona** (`infra/tiempo-real/sse.ts`):
- **Solo lo propio.** El stream escucha el canal del usuario, y el relay publica cada evento solo en el canal de su pasajero y de su chofer. Una oferta le llega solo a su chofer; un cobro, solo a su pasajero. La reposición filtra por destinatario igual.
- **Reconexión sin huecos.** Primero se suscribe al canal, guardando lo que llegue. Después repone del outbox lo que tiene `seq` mayor que el `Last-Event-ID`, hasta 500 eventos, incluso lo que el relay todavía no publicó. Recién ahí manda lo guardado. Así nada se pierde entre la reposición y lo nuevo.
- **Sin repetidos.** Cada stream descarta los `seq` que ya mandó y los que no superan el `Last-Event-ID`. Cubre la entrega al menos una vez del relay, y el evento que llega por la reposición y también en vivo.
- **Latido** cada 15 s (un comentario `: latido`), para que un proxy no corte la conexión por inactividad.
- **Token vencido:** el stream se cierra cuando vence el token, y el cliente se reconecta con uno nuevo.
- **Límite:** como mucho `SSE_MAX_POR_USUARIO` (3) streams abiertos por usuario. El cuarto recibe 429 `DEMASIADAS_CONEXIONES`. Cada stream ocupa memoria y una suscripción, y sin límite un atacante podría abrir miles.
- **Redis caído:** 503 `EVENTOS_NO_DISPONIBLE`.
- **Apagado:** los streams no terminan solos, así que se cortan al empezar el apagado (`alEmpezar` en `platform`) y el cliente se reconecta a otra instancia. Si no, el servidor esperaría hasta el timeout.

**Una limitación del orden.** Dentro de un viaje, el `seq` sigue el orden de confirmación, porque todo lo que cambia un viaje toma antes el lock de su fila. Entre dos viajes distintos del mismo usuario (por ejemplo, el cobro del viaje anterior y la solicitud nueva), un evento con `seq` menor puede confirmar después de uno mayor. Si justo en ese momento el cliente se desconecta, la reposición con `Last-Event-ID` no lo trae. Por eso el cliente pide el estado actual al reconectar.

**Tests** (`tests/integracion/tiempo-real.test.ts`, `tests/externos/sse.test.ts`, `tests/concurrencia/relay.test.ts`):
- el viaje de punta a punta en vivo, para el pasajero y el chofer;
- cada uno ve solo lo suyo, también al reponer;
- la reconexión repone exactamente lo perdido, también lo que todavía no se publicó;
- un evento publicado dos veces llega una sola vez;
- lo que llega durante la reposición sale después, en orden;
- el límite de 3 streams, el token vencido, el apagado, el latido y el 503.

Comprobado que fallan sin el `SKIP LOCKED` del relay, sin el filtro por destinatario de la reposición, sin el descarte de repetidos y sin la espera durante la reposición.

## Posición en vivo

location publica las dos, cada una en su canal y con su contrato (ver [docs/location.md](location.md#posición-en-vivo)):

| De quién | Canal | Contrato | Lo recibe | Evento SSE |
|---|---|---|---|---|
| Chofer, en cada ping que guarda | `<LOCATION_REDIS_PREFIJO>posicion:<choferId>` | `PosicionChoferPublicada` | el pasajero de su viaje activo | `DriverLocationUpdated` |
| Pasajero (`POST /ubicaciones/pasajero`) | `<LOCATION_REDIS_PREFIJO>posicion-pasajero:<pasajeroId>` | `PosicionPasajeroPublicada` | el chofer de su viaje activo | `PassengerLocationUpdated` |

location no sabe de viajes: dispatch es quien sabe qué viaje tiene cada uno, así que la regla de privacidad se aplica acá (`infra/tiempo-real/seguimiento.ts`, el mismo código para los dos sentidos):

- **Solo la ve la otra parte del viaje.** El stream de un pasajero sigue al chofer de su viaje activo, y el de un chofer al pasajero del suyo, mientras está `ASIGNADO`, `EN_CAMINO` o `EN_CURSO`. Nadie más la recibe: ni uno mismo, ni otros pasajeros u otros choferes. Los streams de operador y admin de flota no siguen a nadie.
- **A quién seguir lo dice la base, no los eventos.** Al conectar, y después de cada `TripAssigned`, `DriverEnRoute`, `TripStarted`, `RideCompleted` o `RideCancelled` (los cinco llegan al pasajero y al chofer), el stream vuelve a leer el viaje activo: `viajeConChoferDelPasajero` (usa el índice único parcial) o `viajeConPasajeroDelChofer` (usa la asignación activa, una fila por chofer). Así no importa el orden en que lleguen los eventos, ni si son de la reposición: reponer el `TripAssigned` de un viaje que ya terminó no vuelve a seguir a nadie. Las lecturas van de a una, y las que se piden mientras otra espera se juntan en una.
- **`SUBSCRIBE` al canal de cada persona seguida**, no `PSUBSCRIBE` a todos, y **una sola suscripción por canal y por instancia**: dos pestañas comparten la suscripción; se da de baja con la última. Una conexión de Redis propia para los dos tipos de canal.
- **Solo mensajes válidos y en orden.** Se descarta lo que no cumple el contrato de ese canal (la posición de un chofer en el canal de un pasajero no pasa, ni al revés), lo que es de otra persona que la del canal, y una posición que no es más nueva que la última enviada.
- **Efímeras.** Van sin `id:`: no se reponen con `Last-Event-ID` (vale la última, y la próxima llega con el siguiente ping) ni mueven el `Last-Event-ID` del cliente. Al empezar a seguir a alguien no se manda la última posición conocida: llega con la próxima.
- **Si Redis o la base fallan**, el stream sigue con los eventos del viaje; solo se pierde la posición, y se reintenta con el próximo evento.
- dispatch usa el mismo `LOCATION_REDIS_PREFIJO` que location (`location:` por defecto).

```
event: DriverLocationUpdated
data: {"solicitudId":"…","choferId":"…","lat":-34.6031,"lng":-58.3815,"actualizadaEn":"2026-11-21T12:00:01.000Z"}

event: PassengerLocationUpdated
data: {"solicitudId":"…","pasajeroId":"…","lat":-34.6001,"lng":-58.3816,"actualizadaEn":"2026-11-23T12:00:01.000Z"}
```

**Tests** (`tests/integracion/posicion-chofer.test.ts` y `posicion-pasajero.test.ts`, contra Postgres y Redis, publicando como location; y `tests/externos/sse.test.ts`):
- el pasajero ve al chofer desde que se asigna hasta que termina el viaje, y el chofer al pasajero desde que acepta; antes y después, nada, y el canal queda sin suscripción;
- nadie más la ve: ni el otro rol, ni otro pasajero, ni otro chofer;
- si el pasajero cancela, dejan de seguirse;
- conectarse a mitad del viaje sigue enseguida, y cada uno ve al otro por su canal, sin cruzarse; dos pestañas, una sola suscripción, que se suelta al cerrar las dos;
- reponer los eventos de un viaje terminado no vuelve a seguir a su chofer;
- se descartan la atrasada, la repetida, la de otra persona, la del contrato equivocado y las que no cumplen el contrato;
- cambia de seguido cuando la base dice otro, y suelta al anterior; los streams de operador y admin de flota no siguen a nadie; si fallan Redis o la base, los eventos siguen llegando.

Comprobado que fallan sin cada una de estas cosas: el filtro por rol, la nueva lectura después de los eventos (también en el stream del chofer), el descarte de atrasadas, la verificación de la persona del canal, el canal y el contrato propios del pasajero, la suscripción compartida, la baja al cerrar el stream y el filtro por estado del lado del pasajero. Del lado del chofer, el filtro por estado es un resguardo: al terminar o cancelar el viaje ya se borra la asignación activa, así que ningún test lo distingue.

## Catálogo

Los esquemas están en [`packages/contracts/src/dispatch.ts`](../packages/contracts/src/dispatch.ts) (`EventosDispatch`). En el stream, `event:` es el tipo y `data:` el payload.

| Evento | Cuándo | Payload | Lo recibe |
|---|---|---|---|
| `RideRequested` | Se crea una solicitud | `solicitudId, pasajeroId, origen, destino` | pasajero |
| `OfferCreated` | Se ofrece el viaje a un chofer | `ofertaId, solicitudId, choferId, venceEn` | ese chofer |
| `OfferExpired` | Vence una oferta sin respuesta | `ofertaId, solicitudId, choferId` | ese chofer |
| `NoDriversFound` | No quedan candidatos | `solicitudId, pasajeroId` | pasajero |
| `TripAssigned` | Un chofer gana la asignación | `solicitudId, pasajeroId, choferId, origen, destino` | pasajero y chofer |
| `DriverEnRoute` | El chofer sale a buscar al pasajero | `solicitudId, pasajeroId, choferId` | pasajero y chofer |
| `TripStarted` | El pasajero sube | `solicitudId, pasajeroId, choferId` | pasajero y chofer |
| `RideCompleted` | Termina el viaje | `solicitudId, pasajeroId, choferId, tarifaFinalCentavos` | pasajero y chofer |
| `RideCancelled` | Cancela el pasajero, el chofer o el operador | `solicitudId, pasajeroId, choferId \| null, estabaAsignada, canceladoPor, motivo` | pasajero y chofer |
| `PaymentCaptured` | El proveedor aprobó el cobro | `cobroId, solicitudId, pasajeroId, montoCentavos, moneda, referencia` | pasajero |
| `PaymentDeclined` | El proveedor rechazó el cobro | lo mismo, más `motivo` | pasajero |
| `DriverLocationUpdated` | Llega una posición del chofer (de location, sin `id`) | `solicitudId, choferId, lat, lng, actualizadaEn` | el pasajero de ese viaje |
| `PassengerLocationUpdated` | Llega una posición del pasajero (de location, sin `id`) | `solicitudId, pasajeroId, lat, lng, actualizadaEn` | el chofer de ese viaje |
