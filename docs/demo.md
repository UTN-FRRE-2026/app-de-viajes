# Guion de la demo

La demo del enunciado (6.8, y el punto 8 de la verificación del [plan](../PLAN.md#7-verificación)): ciclo completo con seguimiento, oferta que vence con el chofer desconectado, ubicación ajena rechazada, 500 choferes con medición antes y después, y la variante G con su carrera. Se suman la idempotencia, el panel del operador y location detenido.

Cada paso dice qué mostrar y con qué: una pantalla (http://localhost:8080), un pedido de la colección [demo.http](demo.http) o un comando. La colección está en el formato de REST Client de VS Code y se ejecuta de arriba hacia abajo.

## 0. Antes de empezar

```bash
npm install
npm run setup                  # .env, clave, bases, migraciones y usuarios de prueba
docker compose up -d --build   # postgres, redis, identity, location, dispatch y web
npm run demo:flotas            # zonas Resistencia y Corrientes, las dos flotas, el chofer del seed habilitado y activo
npm test                       # una vez, para tener los tests de concurrencia a mano (pasos 7 y 8)
```

- **Usuarios:** los del seed, todos con la contraseña `IDENTITY_SEED_CONTRASENA` del `.env` (`solo-desarrollo-viajes-2026` en `.env.example`). Tabla completa en el [README](../README.md#usuarios-de-prueba).
- **Una pestaña por rol:** el frontend guarda la sesión en `sessionStorage`, que es de cada pestaña. Pasajero, chofer, operador y admin de flota pueden estar abiertos a la vez en el mismo navegador. No uses «Duplicar pestaña»: copia la sesión.
- **Para la demo por API,** las ofertas duran 15 s (`OFERTA_TTL_SEGUNDOS`). Si hace falta más tiempo para aceptar desde la colección, se sube en el `.env` y se recrea dispatch: `docker compose up -d dispatch`.
- **Si un pedido da 429 `DEMASIADOS_PEDIDOS`,** es el límite de tasa de la solicitud de viaje por pasajero (`LIMITE_SOLICITUDES_POR_MINUTO`, 10 por minuto): esperá un minuto.
- **Si el pasajero quedó con un viaje activo** de una prueba anterior, la solicitud da 409 `SOLICITUD_ACTIVA_EXISTENTE`: el operador lo cancela desde `/operador`.

## 1. Tres servicios en contenedores separados

| Qué mostrar | Cómo |
|---|---|
| `identity`, `dispatch` y `location`, cada uno en su contenedor, más `web`, `postgres` y `redis` | `docker compose ps` |
| nginx como único punto de entrada: CSP, encabezados, lo interno sin publicar, SSE sin buffer | `npm run web:probar` |
| Lo interno no pasa por nginx | [demo.http](demo.http), sección 9: `/api/ubicacion/interno/candidatos` y `/api/viajes/metrics` dan 404 |

Arquitectura: [arquitectura.md](arquitectura.md).

## 2. Login por rol

1. En http://localhost:8080/login, entrar como cada rol. Cada uno va a su pantalla: `pasajero` a `/pasajero`, `chofer` a `/chofer`, `operador` y `admin` a `/operador`, `admin_flota` a `/flota`.
2. Con la sesión del pasajero, abrir `/operador` en la URL: «Esta pantalla no es para tu rol».
3. Por la API, lo mismo con 403: [demo.http](demo.http), sección 9 (el pasajero pide el panel, el chofer pide un viaje).

Lo recorre el flujo 1 de Playwright (`e2e/tests/01-login-roles.spec.ts`).

## 3. Ciclo completo con seguimiento en vivo

Dos pestañas: el chofer a la izquierda y el pasajero a la derecha.

1. **Chofer** (`/chofer`): «Disponible», y en la ubicación elegir **Manual (demo)** con un punto cerca de la Plaza 25 de Mayo (por ejemplo `-27.4515`, `-58.9869`). La ubicación se reenvía cada 5 s.
2. **Pasajero** (`/pasajero`): origen «Plaza 25 de Mayo» y destino «Domo del Centenario» de la lista de lugares. Se ve la **estimación**; «Pedir viaje».
3. **Chofer:** la oferta aparece sola (SSE `OfferCreated`), con la cuenta regresiva de 15 s y la tarifa estimada. «Aceptar».
4. **Pasajero:** la línea de tiempo prende «Chofer asignado» en vivo, con cuánto tardó, y el chofer aparece en el mapa (SSE `DriverLocationUpdated`).
5. **Chofer:** «Voy en camino», «Inició el viaje», «Finalizar». Cada paso se prende del lado del pasajero.
6. **Pasajero:** «Terminado» con la tarifa final y, en unos 2 s, «Cobrado» (el barrido procesa el cobro). El historial, en `/pasajero/historial`.

**Por la API**, lo mismo: [demo.http](demo.http), secciones 1 a 6.

**El stream SSE a la vista** (opcional), en PowerShell:

```powershell
$token = (Invoke-RestMethod -Method Post http://localhost:8080/api/identity/login -ContentType 'application/json' `
  -Body '{"email":"pasajero@viajes.test","contrasena":"solo-desarrollo-viajes-2026"}').token
curl.exe -N -H "Authorization: Bearer $token" http://localhost:8080/api/viajes/eventos
```

- Cada evento sale con `id:` (el `seq` del outbox), `event:` y `data:`. Cada 15 s, un `: latido`.
- **Reconexión:** cortar con Ctrl+C y volver a conectar con `-H "Last-Event-ID: <último id>"`: llega exactamente lo que se perdió, sin repetidos ([eventos.md](eventos.md)).

Lo recorre el flujo 2 de Playwright, con dos navegadores (`02-viaje-completo.spec.ts`).

## 4. Idempotencia

[demo.http](demo.http), sección 4:
1. **Solicitar** con `Idempotency-Key: {{claveSolicitud}}`: 201.
2. **Repetirlo igual:** el mismo 201, con `Idempotent-Replayed: true`. No hay segunda solicitud.
3. **La misma clave con otro destino:** 422 `CLAVE_IDEMPOTENCIA_REUTILIZADA`.
4. **Sin la clave:** 400 `CLAVE_IDEMPOTENCIA_INVALIDA`.

Cambiar `@claveSolicitud` antes de cada corrida: la respuesta se guarda 24 h. Decisión y tests: [ADR 0010](adr/0010-idempotencia.md).

## 5. Oferta que vence con el chofer desconectado

1. **Chofer:** disponible, con su ubicación manual cerca de la Plaza 25 de Mayo.
2. **Cerrar la pestaña del chofer.** Para el sistema sigue disponible, y su última posición vale 30 s (`UBICACION_VIGENCIA_SEGUNDOS`).
3. **Pasajero,** dentro de esos 30 s: pedir un viaje desde la Plaza 25 de Mayo. La oferta va al chofer desconectado.
4. **Esperar unos 15 s** (`OFERTA_TTL_SEGUNDOS`) más hasta 2 s del barrido. El servidor marca la oferta vencida (`OfferExpired`): no depende de que el celular del chofer avise nada. No queda otro chofer apto, así que la solicitud pasa a `SIN_CHOFERES` y el pasajero ve el paso en rojo («sin choferes»).
5. En `/operador`, filtrar por `SIN_CHOFERES`: ahí está el viaje.

Decisión: [ADR 0011](adr/0011-vencimiento-ofertas.md).

**Que pasa al siguiente chofer:** lo muestra el flujo 3 de Playwright, con dos choferes. La oferta llega primero al más cercano, y solo a él; la deja vencer y el viaje pasa al otro, que lo acepta.

```bash
npm run e2e:levantar                                          # ofertas de 6 s y una a la vez
npx -w @viajes/e2e playwright test 03-oferta-vence --headed   # con el navegador a la vista
```

`npm run e2e:levantar` cambia la configuración del Compose hasta el próximo `docker compose up -d` sin esas variables ([ci.md](ci.md)).

## 6. Panel del operador: búsqueda y cancelación con motivo

En `/operador` (como `operador@viajes.test`):
1. **Sin filtro:** los viajes activos; se refresca cada 10 s.
2. **Por estado** y **con búsqueda:** un pedazo del id de un viaje, del pasajero (`000000000001`) o del chofer, o una palabra de un motivo de cancelación.
3. **Cancelar con motivo** un viaje activo: el motivo es obligatorio (de 3 a 200 caracteres). El pasajero ve quién canceló y por qué.

Por la API: [demo.http](demo.http), sección 7. Incluye la búsqueda con `' OR 1=1 --`, que se busca como texto y no trae nada, y la cancelación sin motivo, que da 422 `MOTIVO_REQUERIDO`.

## 7. Variante G: flotas y su carrera

**En pantalla** (`/flota`, como `admin.flota@viajes.test`):
1. El cupo: «Activos N de 5».
2. **Alta de un chofer:** su código (el UUID que ve el chofer en `/chofer` mientras no está en una flota) y el vehículo. Queda «Pendiente de habilitación por el admin de la plataforma».
3. Habilitarlo es del admin de la plataforma, por la API (`POST /api/viajes/admin/choferes/:id/habilitar`).
4. **Activar hasta el límite:** el siguiente recibe «La flota llegó a su límite».
5. **Viajes y facturación:** el reporte del mes, con lo facturado (solo los cobros aprobados) y los viajes completados.

**Por la API**, todo junto: [demo.http](demo.http), sección 8. El admin baja el límite a 1, un chofer nuevo se registra, se da de alta y se habilita; activarlo da 409 `LIMITE_FLOTA_ALCANZADO`; con el límite en 5, entra.

**Aislamiento:** el admin de la Flota Corrientes pide un chofer de la Flota Demo y recibe 404, como si no existiera (sección 8). Lo recorre el flujo 4 de Playwright.

**La carrera G:** 50 activaciones simultáneas con límite 10 dejan exactamente 10 activos.

```bash
npm test -w @viajes/dispatch -- tests/concurrencia/flotas.test.ts
```

Qué falla si se saca cada protección: [flotas.md](flotas.md#cómo-se-sabe-que-el-test-detecta-la-falta-de-la-protección).

## 8. Asignación única (6.3)

```bash
npm test -w @viajes/dispatch -- tests/concurrencia/asignacion-unica.test.ts
```

50 choferes aceptan la misma solicitud a la vez: uno gana y los otros 49 reciben 409. Con los servicios en `npm run dev` y `DISPATCH_LOG_SQL=1` (en el `.env` o en la terminal), se ve el `SELECT ... FOR UPDATE` en el log. Decisión: [ADR 0004](adr/0004-asignacion-unica.md).

Con k6, contra el sistema en contenedores (PowerShell): `powershell -NoProfile -ExecutionPolicy Bypass -File carga/carrera.ps1 -Corrida 1`. Exige exactamente 1×200 y 49×409 `SOLICITUD_NO_DISPONIBLE`, y lo verifica en Postgres ([carga/README.md](../carga/README.md#carrera-de-la-asignación-única-63)).

## 9. Ubicación ajena y otros errores

[demo.http](demo.http), sección 9:

| Caso | Respuesta |
|---|---|
| El chofer manda su ubicación con un `choferId` en el cuerpo | 400 `VALIDACION`: la posición es siempre la del token |
| Un pasajero manda una ubicación de chofer | 403 `ROL_NO_PERMITIDO` |
| Un chofer pide un viaje; el operador abre el stream de eventos; el pasajero pide el panel | 403 `ROL_NO_PERMITIDO` |
| Latitud 200, una clave de más (`__proto__`), JSON mal formado | 400 `VALIDACION` o `JSON_INVALIDO` |
| Registrar un `admin` por el registro público | 400 `VALIDACION` |
| Sin token | 401 `NO_AUTENTICADO` |
| El admin de flota pide un viaje que no es suyo | 404 `SOLICITUD_NO_ENCONTRADA`, igual que uno inexistente |

**La posición en vivo** la ve solo la otra parte del viaje: en el paso 3, el stream de otro pasajero (uno registrado para la demo) no recibe `DriverLocationUpdated`. Lo prueban los tests de `services/dispatch/tests/integracion/posicion-chofer.test.ts` y `posicion-pasajero.test.ts` ([eventos.md](eventos.md#posición-en-vivo)).

Todos los errores tienen el mismo formato, `{ "error": { "code", "message", "requestId" } }`, sin detalles internos.

## 10. location detenido: la solicitud da 503 y el login sigue

```bash
docker compose stop location
```

1. **Pasajero** pide un viaje ([demo.http](demo.http), sección 10, o la pantalla): **503 `UBICACION_NO_DISPONIBLE`**, y no se crea nada (falla cerrado). La pantalla muestra el mensaje con su `requestId`.
2. **Login** de cualquier usuario: 200. identity y dispatch siguen respondiendo.
3. `docker compose start location`, y el pedido vuelve a andar (el chofer tiene que volver a mandar su ubicación).

Con `docker compose pause location` el contenedor sigue en la red pero no contesta: el 503 llega cuando vence el timeout de dispatch (`LOCATION_TIMEOUT_MS`, 1 s). Después, `docker compose unpause location`.

## 11. 500 choferes con k6: antes y después

En un entorno de Compose aparte (`viajes-carga`), que no toca el de desarrollo. PowerShell, desde la raíz:

```powershell
node carga/preparar.mjs   # la primera vez: secretos y 500 tokens de chofer
powershell -NoProfile -ExecutionPolicy Bypass -File carga/medir.ps1 -Estrategia ingenua -Corrida 1 -Medicion 30 -Calentamiento 5
powershell -NoProfile -ExecutionPolicy Bypass -File carga/medir.ps1 -Estrategia optimizada -Corrida 1 -Medicion 30 -Calentamiento 5
```

- Es la **prueba corta**: 500 choferes con un ping cada 2 s (250 pings/s), 20 búsquedas/s y `/health`, durante 30 s. Cada corrida deja todo en `docs/mediciones/<fecha>/<estrategia>-<corrida>/`.
- Con `-Solicitudes` corre además viajes de punta a punta en paralelo, con dispatch de carga.
- La corrida completa (5 min de medición) tarda unos 7 minutos: para la demo, mostrar los números del informe.

**Los números del informe** ([mediciones.md](mediciones.md), mediana de 3 corridas por versión):

| | Ingenua (un `INSERT` por ping) | Optimizada (Redis GEO + historial en lotes) |
|---|---|---|
| `POST /ubicaciones`, p95 | 4624 ms | 3,7 ms |
| Búsqueda de candidatos, p95 | 4668 ms | 5,9 ms |
| Pings aceptados | 125 a 150 por segundo, de 250 | los 250 por segundo |
| Viajes con los 500 choferes de fondo | el 100 % responde 503 `UBICACION_NO_DISPONIBLE` al vencer el timeout de 1 s | `POST /solicitudes` p95 249 ms; asignación p95 581 ms |
| Lag p99 de dispatch durante la carga | ≤ 2 ms | ≤ 5 ms |

La ingenua no se traba por el event loop sino por Postgres: cada ping espera su commit. El lag de dispatch no se mueve porque location corre en su propio proceso. Decisión: [ADR 0005](adr/0005-tarea-pesada.md). Cómo se mide y las limitaciones: [carga/README.md](../carga/README.md) y [mediciones.md](mediciones.md).

## 12. Métricas y logs

```powershell
curl.exe -H "Authorization: Bearer <METRICAS_TOKEN del .env>" http://localhost:3005/metrics
docker compose logs dispatch --tail 20
```

- `/metrics` de dispatch: `dispatch_solicitudes_total`, `dispatch_asignaciones_total`, `dispatch_ofertas_vencidas_total` (sube con el paso 5), `dispatch_tiempo_hasta_asignacion_seconds` y el lag del event loop. Va al puerto del servicio: nginx no lo publica.
- En el log, una línea JSON por pedido con su `requestId`, el mismo que devuelve un error: así se encuentra el pedido que lo causó.
