# API pública

Lo que ve un cliente detrás de nginx (`infra/web/default.conf`), el único punto de entrada. En el Compose es `http://localhost:8080`. Las rutas de cada servicio salen de `services/*/src/infra/http/*.ts` y los esquemas, de `packages/contracts/src`.

| Prefijo | Servicio | Ejemplo |
|---|---|---|
| `/api/identity/` | identity (3001) | `POST /api/identity/login` |
| `/api/viajes/` | dispatch (3005) | `POST /api/viajes/solicitudes` |
| `/api/ubicacion/` | location (3004) | `POST /api/ubicacion/ubicaciones` |

nginx saca el prefijo y reenvía el resto: `/api/viajes/solicitudes` llega a dispatch como `/solicitudes`. En las tablas de abajo, cada ruta va **sin el prefijo**, bajo el título de su servicio.

**Lo que no se publica.** `/interno/*`, `/metrics` y `/ready`, en los tres prefijos, sin distinguir mayúsculas, responden `404 RUTA_NO_ENCONTRADA` desde nginx, con el formato único de error. Cualquier otro `/api/...` que no sea de un servicio, también. Están documentadas [aparte](#rutas-internas-no-publicadas).

## Convenciones

### Autenticación y roles

- `Authorization: Bearer <access token>`, el JWT que devuelve `POST /api/identity/login` (RS256, `JWT_TTL_SEGUNDOS`, 15 min por defecto). dispatch y location lo verifican con el JWKS de identity, sin consultarlo en cada pedido. Ver [docs/identity.md](identity.md#token).
- Roles: `pasajero`, `chofer`, `operador`, `admin` y `admin_flota`. El token del `admin_flota` trae además `fleetId`.
- **Quién es el usuario sale siempre del token**, nunca del cuerpo ni de la query: un `choferId`, `pasajeroId` o `fleetId` en el cuerpo es una clave no declarada y da 400.
- Sin token, o con uno inválido o vencido: `401 NO_AUTENTICADO`. Con un rol que la ruta no admite: `403 ROL_NO_PERMITIDO`.

### Errores

Todas las respuestas de error tienen la misma forma (`packages/platform/src/errores.ts`), y nunca traen el stack:

```json
{ "error": { "code": "SOLICITUD_ACTIVA_EXISTENTE", "message": "Ya tenés una solicitud activa", "requestId": "…" } }
```

`requestId` es el mismo id del log de nginx y del servicio (`X-Request-Id`). Los errores de dominio se traducen por su tipo: no encontrado → 404, conflicto → 409, inválido → 422, prohibido → 403, no autenticado → 401.

Los que pueden salir en cualquier ruta:

| Respuesta | Cuándo |
|---|---|
| `400 VALIDACION` | El cuerpo, la query o los parámetros no cumplen el esquema Zod. Los esquemas son `strictObject`: una clave no declarada también da 400. El mensaje dice qué campo falla |
| `400 JSON_INVALIDO` | El cuerpo no es JSON |
| `401 NO_AUTENTICADO` / `403 ROL_NO_PERMITIDO` | Ver arriba |
| `404 RUTA_NO_ENCONTRADA` | La ruta no existe, o no se publica |
| `413 CUERPO_DEMASIADO_GRANDE` | El cuerpo pasa los 16 kB de los servicios. Por encima de 32 kB lo corta nginx antes (`client_max_body_size`), con su propia página de error |
| `500 INTERNO` | Un error no controlado. El detalle queda en el log, con el `requestId` |

Un recurso ajeno responde **igual que uno inexistente** (404): un viaje de otro pasajero, una oferta de otro chofer, un chofer de otra flota. No se revela que existe.

### Idempotency-Key

Todas las escrituras de dispatch (`POST` y `PUT`) y `POST /registro` de identity **exigen** el encabezado ([ADR 0010](adr/0010-idempotencia.md)). En las tablas, la columna **Idem.** lo marca.

- Formato: de 16 a 128 letras, números, `-` o `_` (un UUID sirve). Una clave nueva por operación, y **la misma en cada reintento** de esa operación.
- La clave es de un usuario (del token). En `/flota/*`, del usuario y su flota; en `/registro`, del email.
- Solo se guarda lo que salió bien, durante `IDEMPOTENCIA_RETENCION_HORAS` (24 h) como mínimo. Un pedido que falló se puede reintentar con la misma clave.

| Respuesta | Cuándo |
|---|---|
| La respuesta original, con `Idempotent-Replayed: true` | Reintento con la misma clave y el mismo pedido (método, ruta y cuerpo). Sin un segundo efecto |
| `400 CLAVE_IDEMPOTENCIA_INVALIDA` | Falta el encabezado o no tiene el formato |
| `409 CLAVE_IDEMPOTENCIA_EN_CURSO` | Otro pedido con la misma clave está en curso. Con `Retry-After: 1` |
| `422 CLAVE_IDEMPOTENCIA_REUTILIZADA` | La misma clave con otro pedido |
| `503 IDEMPOTENCIA_NO_DISPONIBLE` | Redis no responde: falla cerrado, no se procesa |

El encabezado se revisa después del rol y de validar el cuerpo: un pedido rechazado por eso no ocupa la clave.

### Límites de tasa

| Ruta | Límite | Por | Variable | Respuesta |
|---|---|---|---|---|
| `POST /api/identity/login` | 5 intentos por email y 30 por IP, en una ventana fija de 900 s | email (hasheado) e IP | `IDENTITY_LOGIN_MAX_POR_EMAIL`, `IDENTITY_LOGIN_MAX_POR_IP`, `IDENTITY_LOGIN_VENTANA_SEGUNDOS` | `429 DEMASIADOS_INTENTOS` |
| `POST /api/viajes/solicitudes` | 10 por minuto | usuario del token | `LIMITE_SOLICITUDES_POR_MINUTO` | `429 DEMASIADOS_PEDIDOS` |
| `POST /api/ubicacion/ubicaciones` y `POST /api/ubicacion/ubicaciones/pasajero` | 120 por minuto | usuario del token | `LIMITE_UBICACIONES_POR_MINUTO` | `429 DEMASIADOS_PEDIDOS` |
| `GET /api/viajes/eventos` | 3 streams abiertos a la vez | usuario del token | `SSE_MAX_POR_USUARIO` | `429 DEMASIADAS_CONEXIONES` |

- Toda respuesta que pasó por un contador trae `RateLimit-Limit`, `RateLimit-Remaining` y `RateLimit-Reset` (segundos hasta que se reinicia la ventana). Un 429 trae además `Retry-After`.
- **El login falla cerrado:** si Redis no responde, `503 LIMITE_NO_DISPONIBLE` y no se verifica ninguna contraseña. El detalle en [docs/identity.md](identity.md#límite-de-intentos-de-login).
- **Solicitudes y ubicaciones fallan abierto:** si el contador no responde, el pedido pasa y queda un aviso en el log. Protegen la capacidad, no un secreto.
- Los límites de solicitudes y ubicaciones son de ventana fija de 60 s, y con `0` se desactivan (el entorno de carga). Las dos rutas de location comparten el mismo contador por usuario.
- En `POST /solicitudes` el límite corre **después** de la `Idempotency-Key`: un reintento con la misma clave recibe la respuesta guardada sin gastar cupo, y un 429 no queda guardado con la clave. Detalle en [docs/seguridad.md](seguridad.md#límite-de-tasa).
- El de los streams SSE se cuenta entre todas las instancias de dispatch (Redis), y falla abierto: si Redis no responde, queda el límite de cada instancia.

## identity (`/api/identity`)

Detalle de cada respuesta en [docs/identity.md](identity.md#endpoints).

| Ruta | Rol | Entrada | Respuesta | Errores propios | Idem. |
|---|---|---|---|---|---|
| `POST /registro` | público | `{email, contrasena, nombre, rol}`. `contrasena` de 12 a 128; `nombre` de 1 a 100; `rol`: `pasajero` o `chofer` | `201 {id, email, nombre, rol, creadoEn}` | `409 IDENTIFICADOR_EN_USO`; un rol privilegiado da `400` | sí |
| `POST /login` | público | `{email, contrasena}` | `200 {token, tipo:"Bearer", expiraEnSegundos, refreshToken, refreshExpiraEnSegundos, usuario}`, con `Cache-Control: no-store` | `401 CREDENCIALES_INVALIDAS` (email inexistente o contraseña incorrecta, la misma respuesta), `429 DEMASIADOS_INTENTOS`, `503 LIMITE_NO_DISPONIBLE` | no |
| `POST /refresh` | público | `{refreshToken}` (hasta 256 caracteres) | `200`, igual que el login, con tokens nuevos. El refresh enviado deja de servir | `401 REFRESH_INVALIDO` (no existe, venció, revocado o reusado; reusar uno revoca la sesión entera) | no |
| `POST /logout` | público | `{refreshToken}` | `204`, también si el token no existe | — | no |
| `GET /.well-known/jwks.json` | público | — | `200 {keys:[…]}`, solo las claves públicas, con `Cache-Control: public, max-age=300` | — | no |

- El email se normaliza: en minúsculas y sin espacios alrededor.
- `usuario` es `{id, email, nombre, rol, fleetId?, creadoEn}`; `fleetId` solo en un `admin_flota`.
- `/refresh` y `/logout` no piden el access token: funcionan aunque haya vencido.

## dispatch (`/api/viajes`)

Respuestas que se repiten:
- **Solicitud** (`SolicitudRespuesta`, `packages/contracts/src/chofer.ts`): `{id, pasajeroId, origen:{lat,lng}, destino:{lat,lng}, estado, choferId, motivoCancelacion, tarifa, version}`. `tarifa` trae la estimación y, al completar, la final ([docs/tarifas.md](tarifas.md)). `version` crece con cada cambio del viaje.
- **Listado de viajes:** `{viajes:[solicitud + creadaEn], siguiente}`. `siguiente` es el `desde` de la página siguiente, o `null`.
- **Coordenada:** `{lat, lng}`, lat de −90 a 90 y lng de −180 a 180.
- **Paginación** (query): `limite` de 1 a 50 (20 por defecto) y `desde` de 0 a 10 000 (0 por defecto).

Los estados y quién dispara cada transición: [docs/modelo.md](modelo.md#la-máquina-de-estados-del-viaje).

### Viajes

| Ruta | Rol | Entrada | Respuesta | Errores propios | Idem. |
|---|---|---|---|---|---|
| `POST /solicitudes` | `pasajero` | `{origen, destino}` | `201` solicitud: `BUSCANDO` con ofertas, o ya `SIN_CHOFERES` | `409 SOLICITUD_ACTIVA_EXISTENTE`; `422 ORIGEN_FUERA_DE_ZONA` (no se crea); `422 VIAJE_FUERA_DE_RANGO`; `429 DEMASIADOS_PEDIDOS`; `503 MAPAS_NO_DISPONIBLE` o `UBICACION_NO_DISPONIBLE` (no se crea) | sí |
| `GET /solicitudes/:id` | cualquiera: el pasajero y el chofer del viaje; `operador` y `admin`, todos | — | `200` solicitud más `cobro` (`null` hasta que se completa) | `404 SOLICITUD_NO_ENCONTRADA` | — |
| `POST /ofertas/:id/aceptar` | `chofer` (el de la oferta) | `{}` | `200` solicitud `ASIGNADO` | `404 OFERTA_NO_ENCONTRADA`; `409 SOLICITUD_NO_DISPONIBLE` (otro ganó o se canceló), `OFERTA_VENCIDA`, `CHOFER_NO_APTO` (ya no está habilitado, activo o disponible, o su flota no opera en la zona), `CHOFER_CON_VIAJE_ACTIVO` | sí |
| `POST /solicitudes/:id/en-camino` | `chofer` asignado | `{}` | `200` solicitud `EN_CAMINO` | `404 SOLICITUD_NO_ENCONTRADA`; `409 TRANSICION_INVALIDA` | sí |
| `POST /solicitudes/:id/iniciar` | `chofer` asignado | `{}` | `200` solicitud `EN_CURSO` | igual | sí |
| `POST /solicitudes/:id/finalizar` | `chofer` asignado | `{}` | `200` solicitud `COMPLETADA`, con la tarifa final. Crea el cobro `PENDIENTE` | igual | sí |
| `POST /solicitudes/:id/cancelar` | `pasajero`, `chofer` asignado, `operador`, `admin` | `{motivo?}`, de 3 a 200 caracteres. **Obligatorio** para `operador` y `admin` | `200` solicitud `CANCELADO_PASAJERO`, `CANCELADO_CHOFER` o `CANCELADO_OPERADOR` | `404 SOLICITUD_NO_ENCONTRADA`; `409 SOLICITUD_NO_CANCELABLE`; `422 MOTIVO_REQUERIDO` | sí |
| `POST /solicitudes/:id/cobrar` | `pasajero` (el suyo), `operador`, `admin` | `{}` | `200 {id, solicitudId, pasajeroId, montoCentavos, moneda, estado, intentosFallidos, referencia, motivoRechazo}`. Si ya estaba aprobado o rechazado, lo devuelve como está | `404 COBRO_NO_ENCONTRADO` (no existe, es de otro o el viaje no terminó); `503 PAGOS_NO_DISPONIBLE` (queda `PENDIENTE`) | sí |
| `GET /historial?limite&desde` | `pasajero`, `chofer` | paginación | `200` listado: sus viajes, del más nuevo al más viejo | — | — |
| `GET /panel/viajes?estado&q&limite&desde` | `operador`, `admin` | paginación; `estado` (uno de los 9); `q` de 1 a 100 caracteres | `200` listado. Sin `estado`, los activos. `q` busca en los ids del viaje, del pasajero y del chofer, y en el motivo de cancelación | — | — |
| `GET /chofer/estado` | `chofer` | — | `200 {ahora, registro, viaje, ofertas}` (`EstadoChoferRespuesta`): su registro en la flota o `null`, su viaje activo o `null`, y sus ofertas pendientes y sin vencer. Con `Cache-Control: no-store` | — | — |

- Cancelar: el pasajero, desde `BUSCANDO`, `ASIGNADO` o `EN_CAMINO`; el chofer, desde `ASIGNADO` o `EN_CAMINO`; el operador y el admin, desde cualquier estado activo.
- Las acciones del chofer y la cancelación toman el mismo lock que la aceptación: la segunda de dos acciones simultáneas ve el estado nuevo y recibe 409.
- Una oferta vence a los `OFERTA_TTL_SEGUNDOS` (15 s), según la hora del servidor. No hay ruta para rechazarla: se deja vencer.

### Tarifas

Detalle en [docs/tarifas.md](tarifas.md).

| Ruta | Rol | Entrada | Respuesta | Errores propios | Idem. |
|---|---|---|---|---|---|
| `GET /tarifas/estimacion?origenLat&origenLng&destinoLat&destinoLng` | `pasajero`, `operador`, `admin` | los cuatro números, obligatorios | `200 {tarifaCentavos, moneda, distanciaMetros, duracionSegundos, desglose, tarifaVersion}` | `422 VIAJE_FUERA_DE_RANGO`; `503 MAPAS_NO_DISPONIBLE` | — |
| `GET /rutas?origenLat&origenLng&destinoLat&destinoLng` | `pasajero`, `chofer`, `operador`, `admin` | los cuatro números, obligatorios | `200 {distanciaMetros, duracionSegundos, puntos: [[lat, lng], …], fuente: "calles" \| "recta"}`, con `Cache-Control: private, max-age=300`. Si el ruteo no responde, la línea recta (`fuente: "recta"`) | `429` pasado `LIMITE_RUTAS_POR_MINUTO` (60) por usuario | — |
| `GET /admin/tarifas` | `admin` | — | `200 {version, moneda, bajadaCentavos, centavosPorKm, centavosPorMinuto, minimoCentavos, maxMetros, actualizadaPor, actualizadaEn}` | — | — |
| `PUT /admin/tarifas` | `admin` | `{bajadaCentavos, centavosPorKm, centavosPorMinuto, minimoCentavos, maxMetros}`, todos enteros: importes de 0 a 100 000 000, `maxMetros` de 1 a 1 000 000 | `200` la versión nueva, en la misma forma que el `GET` | `422 TARIFA_INVALIDA` | sí |

### Flotas y zonas

Detalle, con la carrera del cupo y el alcance por flota, en [docs/flotas.md](flotas.md#rutas). Un chofer se representa como `{id, flotaId, vehiculo:{patente, marca, modelo}, habilitado, activo, disponible}`, y una flota como `{id, nombre, maxActivos, activos}`.

| Ruta | Rol | Entrada | Respuesta | Errores propios | Idem. |
|---|---|---|---|---|---|
| `PUT /admin/flotas/:id` | `admin` | `{nombre, maxActivos}`: nombre de 1 a 80, límite de 0 a 10 000 | `200` la flota (crea o actualiza) | `409 LIMITE_MENOR_QUE_ACTIVOS` | sí |
| `PUT /admin/zonas/:id` | `admin` | `{nombre, area}`: `area` es un `Polygon` de GeoJSON, solo el anillo exterior, cerrado, de 4 a 1000 puntos `[lng, lat]` | `200 {id, nombre, area}` (crea o actualiza) | `422 ZONA_INVALIDA`; `409 ZONAS_SUPERPUESTAS` | sí |
| `GET /admin/zonas` | `admin` | — | `200 {zonas:[{id, nombre, area}]}` | — | — |
| `PUT /admin/flotas/:id/zonas` | `admin` | `{zonas:[uuid]}`, hasta 100. Reemplaza las anteriores | `200 {flotaId, zonas}` | `404 FLOTA_NO_ENCONTRADA`, `ZONA_NO_ENCONTRADA` | sí |
| `POST /admin/choferes/:id/habilitar` | `admin` | `{}` | `200` el chofer | `404 CHOFER_NO_ENCONTRADO` | sí |
| `POST /admin/choferes/:id/deshabilitar` | `admin` | `{}` | `200` el chofer. Si estaba activo, libera su cupo | `404 CHOFER_NO_ENCONTRADO` | sí |
| `GET /flota` | `admin_flota` | — | `200` su flota | `403 FLOTA_NO_ASIGNADA`; `404 FLOTA_NO_ENCONTRADA` | — |
| `GET /flota/choferes?limite&desde` | `admin_flota` | paginación | `200 {choferes, siguiente}` | igual | — |
| `GET /flota/choferes/:id` | `admin_flota` | — | `200` el chofer | `404 CHOFER_NO_ENCONTRADO` (también si es de otra flota) | — |
| `GET /flota/reporte?inicio&fin` | `admin_flota` | instantes ISO 8601 con zona; `inicio < fin`, hasta 366 días | `200 {flotaId, inicio, fin, moneda, viajesCompletados, facturadoCentavos, cobros:{aprobados, pendientes, rechazados}}` | `403 FLOTA_NO_ASIGNADA`; `404 FLOTA_NO_ENCONTRADA` | — |
| `POST /flota/choferes` | `admin_flota` | `{choferId, vehiculo:{patente, marca, modelo}}`. Patente `ABC123` o `AB123CD`; marca y modelo de 1 a 40 | `201` el chofer, deshabilitado, inactivo y no disponible | `422 CUENTA_NO_ES_CHOFER`; `409 CHOFER_YA_REGISTRADO`, `PATENTE_YA_REGISTRADA`; `503 IDENTITY_NO_DISPONIBLE` | sí |
| `POST /flota/choferes/:id/activar` | `admin_flota` | `{}` | `200` el chofer. Ocupa un cupo (si ya estaba activo, no) | `404 CHOFER_NO_ENCONTRADO`; `409 CHOFER_NO_HABILITADO`, `LIMITE_FLOTA_ALCANZADO` | sí |
| `POST /flota/choferes/:id/desactivar` | `admin_flota` | `{}` | `200` el chofer. Libera su cupo y lo deja no disponible | `404 CHOFER_NO_ENCONTRADO` | sí |
| `PUT /chofer/disponibilidad` | `chofer` | `{disponible}` | `200` su registro | `404 CHOFER_NO_ENCONTRADO` (no está en ninguna flota); `409 CHOFER_NO_ACTIVO` | sí |

- La flota de las rutas `/flota/*` es siempre la del token. En sus escrituras, la flota se valida antes de la `Idempotency-Key`, así que `403 FLOTA_NO_ASIGNADA` y `404 FLOTA_NO_ENCONTRADA` también pueden salir ahí.

### Eventos en tiempo real: `GET /eventos` (SSE)

El detalle, con la reposición y la entrega, en [docs/eventos.md](eventos.md#get-eventos-sse).

**Pedido:** `GET /api/viajes/eventos`
- Rol `pasajero` o `chofer`. El usuario sale del token: no hay parámetros, y nadie puede pedir los eventos de otro.
- `Last-Event-ID: <seq>` (opcional): el `id` del último evento recibido, un número de hasta 15 cifras. Se reponen los posteriores, hasta 500.
- `EventSource` no deja mandar el `Authorization`, y el token no va en la URL (quedaría en los logs): el cliente usa `fetch` y lee el cuerpo como stream.

**Respuesta:** `200`, `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.

```
retry: 3000

id: 1042
event: TripAssigned
data: {"solicitudId":"…","pasajeroId":"…","choferId":"…","origen":{…},"destino":{…}}

event: DriverLocationUpdated
data: {"solicitudId":"…","choferId":"…","lat":-34.6031,"lng":-58.3815,"actualizadaEn":"…"}

: latido
```

- `event:` es el tipo y `data:` el payload. Los eventos del viaje traen `id:` (el `seq` del outbox); las posiciones en vivo (`DriverLocationUpdated`, `PassengerLocationUpdated`) no, y no se reponen.
- Cada usuario recibe solo lo suyo. Catálogo de eventos y quién recibe cada uno: [docs/eventos.md](eventos.md#catálogo).
- Un latido (`: latido`) cada 15 s. nginx no usa buffer en esta ruta y la deja abierta hasta 60 s sin datos.
- El stream se cierra cuando vence el token, y al apagar el servicio. El cliente se reconecta con `Last-Event-ID` y relee el estado (`GET /solicitudes/:id` o `GET /chofer/estado`): los eventos avisan, la base es la fuente de verdad.

| Error | Cuándo |
|---|---|
| `400 LAST_EVENT_ID_INVALIDO` | `Last-Event-ID` no es un número |
| `403 ROL_NO_PERMITIDO` | `operador`, `admin` o `admin_flota` |
| `429 DEMASIADAS_CONEXIONES` | Ya tiene 3 streams abiertos (`SSE_MAX_POR_USUARIO`) |
| `503 EVENTOS_NO_DISPONIBLE` | Redis no responde |

## location (`/api/ubicacion`)

Detalle en [docs/location.md](location.md#endpoints). Ninguna de las dos rutas lleva `Idempotency-Key`: una posición repetida no tiene efecto que proteger.

| Ruta | Rol | Entrada | Respuesta | Errores propios |
|---|---|---|---|---|
| `POST /ubicaciones` | `chofer` | `{lat, lng}` | `204`. Se guarda a nombre del chofer del token, con la hora del servidor, y se publica en vivo para el pasajero de su viaje | `429 DEMASIADOS_PEDIDOS`; `503 UBICACION_NO_DISPONIBLE` (versión optimizada con Redis caído) |
| `POST /ubicaciones/pasajero` | `pasajero` | `{lat, lng}` | `204`. Solo se publica para el chofer de su viaje activo: no se guarda | `429 DEMASIADOS_PEDIDOS`; `503 POSICION_NO_PUBLICADA` (sin Redis, caído o sin confirmación en 200 ms) |

- Si la publicación en vivo del chofer falla, `POST /ubicaciones` igual responde `204`: la posición ya quedó guardada.

## Salud

`GET /health` responde `200 {"estado":"ok"}` sin tocar dependencias. Se publica: `/api/identity/health`, `/api/viajes/health` y `/api/ubicacion/health`. `/ready`, que muestra el estado de Postgres y Redis, no.

nginx tiene además `GET /salud` (`200 ok`, texto), para el healthcheck de su contenedor.

## Rutas internas (no publicadas)

Solo de servicio a servicio, dentro de la red del Compose. nginx responde 404 a cualquiera de estas rutas.

| Servicio | Ruta | Quién la llama | Autenticación | Qué hace |
|---|---|---|---|---|
| identity | `GET /interno/usuarios/:id` | dispatch, al dar de alta un chofer en una flota | `X-Token-Servicio: <IDENTITY_TOKEN_SERVICIO>` | `200 {id, rol}`, nada más. `404 USUARIO_NO_ENCONTRADO` |
| location | `GET /interno/candidatos?lat&lng&limite&radioMetros` | dispatch, al buscar choferes | `X-Token-Servicio: <LOCATION_TOKEN_SERVICIO>` | `200 {candidatos:[{choferId, distanciaMetros, actualizadaEn}]}`, del más cercano al más lejano. `limite` de 1 a 100 (10), `radioMetros` de 1 a 50 000 (5000) |
| dispatch | `POST /interno/tramos-viaje` | location, para la retención del historial | `X-Token-Servicio: <DISPATCH_TOKEN_SERVICIO>`. Sin esa variable, la ruta no se monta | Cuerpo `{choferes (1 a 1000), desde, hasta}`; `200 {tramos:[{choferId, inicio, fin}]}`. Acepta cuerpos de hasta 64 kB |
| los tres | `GET /metrics` | Alloy | `Authorization: Bearer <METRICAS_TOKEN>` | Métricas de Prometheus. `401 TOKEN_METRICAS_INVALIDO` |
| los tres | `GET /ready` | quien opera el sistema, desde la red interna | — | `200` o `503 {estado, chequeos}` con el estado de cada dependencia (Postgres, migraciones y, según el servicio, Redis) |

- Sin el token de servicio, o con uno distinto, siempre `401 TOKEN_SERVICIO_INVALIDO` con el mismo mensaje. Se comparan las huellas SHA-256 en tiempo constante, y el JWT de un usuario no sirve.
- Las rutas internas son consultas: no llevan `Idempotency-Key`.
