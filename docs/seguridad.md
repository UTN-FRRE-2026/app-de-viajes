# Seguridad transversal

Lo que comparten los tres servicios vive en `packages/platform` y se arma en `crearApp` ([app.ts](../packages/platform/src/app.ts)), con el mismo orden de middlewares en identity, dispatch y location. Lo propio de cada módulo está en su doc: el login en [identity.md](identity.md), la autorización por flota en [flotas.md](flotas.md), la CSP de la página en [web.md](web.md), la idempotencia en el [ADR 0010](adr/0010-idempotencia.md).

## Orden de los middlewares

| # | Middleware | Qué hace |
|---|---|---|
| 1 | `middlewareRequestId` | Toma el `x-request-id` del nginx (o genera uno) y lo devuelve en la respuesta |
| 2 | `middlewareLogPedidos` | Una línea de log por pedido, al terminar ([abajo](#log-por-pedido)) |
| 3 | `middlewareDuracion` | La duración por ruta para `/metrics` |
| 4 | `middlewareSeguridad` | helmet: CSP `default-src 'none'`, `nosniff`, sin `x-powered-by` |
| 5 | `express.json` | 16 KB por cuerpo (64 KB en `/interno/*` de dispatch); 413 si se pasa, 400 si no es JSON |
| 6 | Rutas | `autenticar` → `requerirRol` → `validar` (Zod estricto) → `idempotente` → límite de tasa → caso de uso |
| 7 | Errores | Único lugar que arma la respuesta de error: `{error:{code,message,requestId}}`, sin stack ni detalles internos |

## Log por pedido

Bloque 4 del enunciado: cada pedido deja una línea JSON (pino) al terminar de responder.

```json
{"level":30,"name":"dispatch","requestId":"4f1c…","metodo":"POST","ruta":"/solicitudes","estado":201,"duracionMs":12.4,"usuarioId":"…","rol":"pasajero","ip":"…","msg":"pedido"}
```

- **Ruta como patrón** (`/solicitudes/:id`), nunca la URL: ni los ids ni la búsqueda del panel (`?q=`) quedan en el log. Es la misma etiqueta que usa `/metrics`.
- **Nivel por estado:** 5xx en `error`, 4xx en `warn`, el resto en `info`. Un 429 o un 403 se ven sin subir el nivel del log.
- **Relacionar pedido y error:** el `requestId` está en la línea del pedido, en la del error no controlado (`error no controlado`), en el encabezado `x-request-id` y en el cuerpo de la respuesta de error. Con el `requestId` que ve el cliente se encuentran las dos líneas.
- Las sondas (`/health`, `/ready`, `/metrics`) no se loguean cuando responden bien: el healthcheck del Compose y Alloy las llaman cada pocos segundos. Si fallan, sí.
- `LOG_PEDIDOS=no` lo apaga. Solo se usa en el entorno de carga (`carga/compose.yml`): 500 choferes son 250 pings por segundo, y las mediciones de [mediciones.md](mediciones.md) se tomaron sin esa línea.

Test: `services/dispatch/tests/seguridad/log-pedidos.test.ts`.

## Límite de tasa

| Ruta | Servicio | Cuenta por | Máximo por defecto | Variable |
|---|---|---|---|---|
| `POST /login` | identity | email y IP | 5 y 30 cada 15 min | `IDENTITY_LOGIN_MAX_POR_EMAIL`, `IDENTITY_LOGIN_MAX_POR_IP` ([identity.md](identity.md#límite-de-intentos-de-login)) |
| `POST /solicitudes` | dispatch | pasajero | 10 por minuto | `LIMITE_SOLICITUDES_POR_MINUTO` |
| `POST /ubicaciones` y `POST /ubicaciones/pasajero` | location | usuario | 120 por minuto | `LIMITE_UBICACIONES_POR_MINUTO` |
| `GET /eventos` (SSE) | dispatch | usuario | 3 streams abiertos, contados entre todas las instancias (Redis) | `SSE_MAX_POR_USUARIO` |

Al pasarse: **429** `DEMASIADOS_PEDIDOS` con `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` y `Retry-After` (en segundos). Los encabezados `RateLimit-*` van también en las respuestas que pasan.

Cómo está hecho ([limite-tasa.ts](../packages/platform/src/limite-tasa.ts)):

- **Ventana fija** de 60 s. Puerto `ContadorTasa` con dos adaptadores: Redis (`INCR` + `PEXPIRE … NX` + `PTTL` en un `MULTI`: atómico, y la clave siempre vence) y memoria (un solo proceso). dispatch usa Redis; location usa Redis en la estrategia optimizada y memoria en la ingenua (es un solo proceso, la cuenta es exacta).
- **Por usuario, no por IP:** va después de `autenticar`, con el `sub` del token. Por IP castigaría a todos los que salen por la misma.
- **En la solicitud va después de `idempotente`:** un reintento con la misma `Idempotency-Key` recibe la respuesta guardada y un duplicado en vuelo el 409, sin gastar cupo. Así la demo de deduplicación (20 pedidos iguales) no choca con el límite. Y como la idempotencia solo guarda lo que salió bien, un 429 no queda pegado a la clave: después del `Retry-After`, el mismo reintento se procesa.
- **Los valores:** un chofer manda un ping cada 2 s (30 por minuto); 120 deja margen para reintentos y para el GPS del navegador. Un pasajero real no pide más de un viaje por minuto; 10 cubre los que cancela y vuelve a pedir.
- **Falla abierto**, a diferencia del login: si Redis no responde, el pedido pasa y queda un `warn`. El login falla cerrado porque sin contador no hay defensa contra la fuerza bruta; acá el límite protege capacidad, no un secreto. Con Redis caído, la solicitud igual contesta 503 por la idempotencia, y en location cortar los pings sería perder las posiciones.
- `0` desactiva el límite: el entorno de carga lo usa, porque un pasajero de k6 pide decenas de viajes por minuto.

Tests: `services/dispatch/tests/seguridad/limite-tasa.test.ts` (unidad, solicitud contra Postgres y la atomicidad del contador en Redis con 50 pedidos simultáneos) y `services/location/tests/seguridad/http.test.ts`.

## Validación y prototype pollution

Todo cuerpo, query, parámetro y encabezado propio (`Idempotency-Key`, `Last-Event-ID`) pasa por un esquema Zod **estricto** (`z.strictObject`): una clave que no está en la lista blanca da 400 `VALIDACION`. El id del usuario siempre sale del token, nunca del cuerpo.

`JSON.parse` deja `__proto__` y `constructor` como claves propias del objeto (no toca el prototipo), y el esquema estricto las rechaza en cualquier nivel. No hay merges profundos de datos del cliente. Tests en los tres servicios, en `tests/seguridad/http.test.ts`: `__proto__` y `constructor.prototype` en la raíz y anidados (dentro de `origen` y `destino` en la solicitud), en el registro, el login, la cancelación y los pings; en todos, 400 y `Object.prototype` sin tocar.

## Inyección SQL

Prisma y `$queryRaw` con parámetros en todas las consultas. La búsqueda del panel del operador (`GET /panel/viajes?q=`) es la única con texto libre: escapa `%`, `_` y `\` del `LIKE` y tiene tests con cargas típicas (`' OR '1'='1`, `UNION SELECT`, `DROP TABLE`) en `services/dispatch/tests/seguridad/http.test.ts`.
