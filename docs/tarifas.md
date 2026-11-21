# Tarifas (dispatch)

Estado:
- **PR 1** (#18): cálculo y estimación.
- **PR 2** (#19): configuración por el admin, con la tarifa global versionada en Postgres, auditoría y caché en Redis.
- **PR 3**: la estimación guardada al crear la solicitud, la tarifa final, por qué difiere y el cobro. Ver [Tarifa final y cobro](#tarifa-final-y-cobro).

> **La fórmula, los importes y el máximo los define el equipo.** Lo que está implementado es la propuesta D1 a D9 de abajo. Los importes del `.env.example` son **de ejemplo**.

## Fórmula

```
recorrido = metros × centavosPorKm / 1000 + segundos × centavosPorMinuto / 60
subtotal  = bajada + recorrido
total     = max(minimo, subtotal)
```

- **Todo en centavos enteros.** Los importes son enteros, las distancias en metros enteros y los tiempos en segundos enteros. El cálculo usa `BigInt`: no hay coma flotante en ningún paso.
- **Un solo redondeo**, a centavo entero y mitad hacia arriba, sobre `recorrido`. Distancia y tiempo se suman sobre el denominador común 6000 antes de dividir. Redondear cada parte por separado podría sumar un centavo de más: con 0,5 de distancia y 0,5 de tiempo da 1 y no 2. Hay un test para esto.
- **Recorrido cero.** Con 0 m y 0 s el recorrido vale 0 y el total es `max(mínimo, bajada)`: el mínimo si la bajada es menor, la bajada si es mayor o igual.
- **El máximo no es parte del cálculo.** `exigirDentroDeRango` rechaza un recorrido de más de `maxMetros` (`422 VIAJE_FUERA_DE_RANGO`), en la estimación y también al crear la solicitud (PR 3). `calcularTarifa` nunca rechaza: un viaje que ya terminó siempre tiene que poder cobrarse, aunque el recorrido real haya salido más largo.

Código:
- `services/dispatch/src/dominio/tarifas/calculo.ts`: `calcularTarifa` y `exigirDentroDeRango`;
- `services/dispatch/src/dominio/tarifas/parametros.ts`: parámetros e invariantes.

La tarifa final del PR 3 tiene que usar **la misma** `calcularTarifa`.

## Parámetros

La tarifa la configura el admin con `PUT /admin/tarifas` (ver [Configuración por el admin](#configuración-por-el-admin)). Los `TARIFA_*` del entorno son **solo la semilla**: crean la versión 1 si la base todavía no tiene tarifa.

| Parámetro | Campo | Variable (semilla) | Ejemplo | Regla |
|---|---|---|---|---|
| Bajada de bandera | `bajadaCentavos` | `TARIFA_BAJADA_CENTAVOS` | 150000 ($1500) | entero, 0 a 100 000 000 |
| Por km | `centavosPorKm` | `TARIFA_CENTAVOS_POR_KM` | 80000 ($800) | entero, 0 a 100 000 000 |
| Por minuto | `centavosPorMinuto` | `TARIFA_CENTAVOS_POR_MINUTO` | 15000 ($150) | entero, 0 a 100 000 000 |
| Mínimo | `minimoCentavos` | `TARIFA_MINIMO_CENTAVOS` | 250000 ($2500) | entero, 0 a 100 000 000 |
| Recorrido máximo | `maxMetros` | `TARIFA_MAX_METROS` | 100000 (100 km) | entero, 1 a 1 000 000 |

Moneda fija: `ARS`. Los límites están en un solo lugar, `packages/contracts/src/dispatch.ts` (`TOPE_IMPORTE_CENTAVOS` y `TOPE_MAX_METROS`), y los usan el contrato del `PUT`, el dominio y la configuración. La base los repite en `CHECK`s. Si un valor de la semilla no cumple, dispatch no arranca y nombra la variable.

**En contenedores**, `docker-compose.yml` le pasa a dispatch las variables `TARIFA_*` y `MAPAS_*` del `.env`. Si una no está, llega vacía. Dispatch trata un valor vacío o con solo espacios como ausente: usa su valor por defecto, nunca 0. Un `0` escrito a propósito sigue valiendo 0 en los importes que lo admiten. Los valores por defecto se definen en un solo lugar, `services/dispatch/src/config/index.ts`.

**Versión.** Cada configuración es una versión: `v1` (la semilla), `v2`, `v3`... La estimación la devuelve en `tarifaVersion`, y la solicitud la guarda: la tarifa final se calcula con esa misma versión (precio congelado, D10).

## Estimación: `GET /tarifas/estimacion`

**Pedido:**
- Con `Authorization: Bearer <access token>`, para los roles `pasajero`, `operador` y `admin`. El chofer recibe 403.
- Es una consulta **sin efectos** (no crea ni guarda nada), así que va por `GET` y **no lleva `Idempotency-Key`**.

```
GET /tarifas/estimacion?origenLat=-34.6037&origenLng=-58.3816&destinoLat=-34.5875&destinoLng=-58.4207
```

**Respuesta** (`200`, `Cache-Control: no-store`, contrato `EstimacionRespuesta` en `packages/contracts/src/dispatch.ts`):

```json
{
  "tarifaCentavos": 754220,
  "moneda": "ARS",
  "distanciaMetros": 5209,
  "duracionSegundos": 750,
  "desglose": {
    "bajadaCentavos": 150000,
    "recorridoCentavos": 604220,
    "subtotalCentavos": 754220,
    "minimoCentavos": 250000,
    "minimoAplicado": false
  },
  "tarifaVersion": "v1"
}
```

Es la respuesta real con los valores de ejemplo del `.env.example` y el mapas simulado (Obelisco → Palermo):
- recorrido: 5209 m × 80 000 / 1000 = 416 720, más 750 s × 15 000 / 60 = 187 500, da 604 220;
- total: 150 000 de bajada más 604 220 de recorrido, 754 220 centavos ($7542,20).

El desglose separa la bajada del recorrido, pero no la distancia del tiempo. Separarlos obligaría a redondear cada uno por separado, y el total podría no coincidir con la suma.

**Errores**, con el formato único `{ error: { code, message, requestId } }`:

| Respuesta | Cuándo |
|---|---|
| `400` | Falta un parámetro, sobra uno, viene repetido, no es numérico o está fuera de rango (lat ±90, lng ±180) |
| `401 NO_AUTENTICADO` / `403 ROL_NO_PERMITIDO` | Sin token, o el rol es `chofer` |
| `422 VIAJE_FUERA_DE_RANGO` | El recorrido supera `TARIFA_MAX_METROS` |
| `503 MAPAS_NO_DISPONIBLE` | Mapas no contestó a tiempo, falló o devolvió algo fuera de contrato. **Falla cerrado**: no se estima con un recorrido inventado |

## Configuración por el admin

**`GET /admin/tarifas`**, solo para el rol `admin`, devuelve la tarifa vigente. Si la base todavía no tiene ninguna, primero la crea con la semilla:

```json
{
  "version": "v2",
  "moneda": "ARS",
  "bajadaCentavos": 200000,
  "centavosPorKm": 90000,
  "centavosPorMinuto": 10000,
  "minimoCentavos": 300000,
  "maxMetros": 120000,
  "actualizadaPor": "00000000-0000-4000-8000-000000000004",
  "actualizadaEn": "2026-11-22T13:05:41.120Z"
}
```

`actualizadaPor` es el `sub` del admin que la configuró, o `semilla` para la versión 1. Contrato: `TarifaAdminRespuesta`.

**`PUT /admin/tarifas`**, solo para `admin` y con **`Idempotency-Key` obligatoria**:
- **Reemplaza la tarifa completa** con los cinco campos de la tabla de arriba, todos obligatorios. Contrato: `ConfigurarTarifaBody`.
- Responde `200` con la versión nueva, en la misma forma que el `GET`.
- Se rechaza con `400` un campo desconocido, un número fraccionario, un valor fuera de rango, un número enviado como texto o un campo que falta.
- **Moneda, versión y autor los pone el servidor.** Si vienen en el cuerpo, son campos desconocidos y dan 400. El autor sale del token.

**Idempotency-Key** (el middleware del #17):
- **Reintento** con la misma clave y el mismo cuerpo: la respuesta original, byte a byte, con `Idempotent-Replayed: true`, sin otra versión ni otra auditoría.
- **La misma clave con otro cuerpo:** `422 CLAVE_IDEMPOTENCIA_REUTILIZADA`.
- **Un duplicado mientras el primero sigue en curso:** `409 CLAVE_IDEMPOTENCIA_EN_CURSO`.
- **Redis de idempotencia caído:** `503 IDEMPOTENCIA_NO_DISPONIBLE`. Falla cerrado.
- **La versión nueva, su auditoría y el registro de la clave se escriben en una sola transacción.** Si algo falla antes del COMMIT, no queda nada, y la misma clave se puede volver a usar.

**Persistencia** (migraciones `20261122000000_tarifas` y `20261122120000_tarifas_auditoria_check`):

| Tabla | Qué guarda |
|---|---|
| `fare_versions` | Una fila por versión, con sus valores, quién la creó y cuándo. **No se modifica nunca** |
| `fare_current` | Una sola fila: la versión vigente |
| `fare_changes` | La auditoría: versión, versión anterior, quién, cuándo, valores anteriores y nuevos, y el `requestId` del pedido |

**Dos admins a la vez.** El `PUT` bloquea la única fila de `fare_current` (`SELECT … FOR UPDATE`), así que las ediciones se serializan:
- el segundo admin espera, relee la vigente que dejó el primero y crea la versión siguiente;
- las dos ediciones se guardan, en versiones seguidas, y queda vigente la última que confirmó;
- el historial queda encadenado: cada cambio registra como valores anteriores los de la versión de verdad anterior. El `CHECK` `fare_changes_cadena_check` lo exige en la base: la versión 1 no tiene anterior ni valores anteriores; desde la 2, `previous_version = version - 1` y los valores anteriores no son nulos. La primera versión del `CHECK` dejaba pasar una versión mayor que 1 sin anterior, porque `NULL = n` da `NULL` y un `CHECK` en `NULL` se cumple. Se corrigió en una migración incremental, porque la original ya estaba aplicada.

No hay control optimista, del tipo «solo si sigue vigente la versión X». Si el equipo lo quiere, se agrega con un `If-Match`.

**La semilla.** Al arrancar, y también en la primera estimación o el primer `GET` si al arrancar no se pudo, dispatch crea la versión 1 con los `TARIFA_*` del entorno:
- solo si la base no tiene ninguna, con `INSERT … ON CONFLICT DO NOTHING`;
- con dos arranques simultáneos, queda una sola versión 1;
- una vez creada, **cambiar el `.env` o reiniciar no pisa** lo que configuró el admin.

**Caché en Redis**, por versión (`dispatch:tarifas:v3`, con TTL `TARIFAS_CACHE_TTL_SEGUNDOS`, 1 h por defecto). En cada estimación:
1. Se pregunta a **Postgres** qué versión está vigente: una fila, por clave primaria. **Este dato nunca sale del caché.**
2. Los parámetros de esa versión se buscan en Redis (HIT) o en Postgres (MISS), y se dejan en Redis.
3. Si Redis falla o tarda más de 200 ms, se usa Postgres. El caché nunca es un punto de falla.

Como las versiones no cambian nunca, una entrada del caché nunca queda vieja. Después de un `PUT`, la próxima estimación ya usa la versión nueva, **aunque falle la invalidación** o una lectura concurrente haya vuelto a dejar la versión anterior en el caché.

La invalidación corre después del COMMIT: deja la nueva versión en Redis y borra **la anterior que leyó la transacción bajo el `FOR UPDATE`**. Con dos admins a la vez, la vigente leída antes de entrar puede no ser la que se reemplazó; por eso `reemplazar` devuelve también `anterior`. Es higiene, no corrección.

En `/metrics`, `dispatch_tarifas_cache_total{resultado="hit|miss|error"}`.

**Modo memoria** (`DISPATCH_PERSISTENCIA=memoria`): las mismas rutas con una tarifa versionada en memoria, sin Redis.

**Alcance.** La tarifa es **global**. Por flota o por zona (variante G) **sigue como decisión del equipo** (D7).

## Puerto de mapas

`ServicioMapas.recorrido(origen, destino) → { metros, segundos }`, en enteros no negativos.

- **Simulado** (`infra/externos/mapas-simulado.ts`): la línea recta (haversine) × `MAPAS_FACTOR_DESVIO` (1,3), a `MAPAS_VELOCIDAD_KMH` (25) constante. Es una **aproximación**, no un ruteo. `MAPAS_LATENCIA_SIMULADA_MS` agrega una demora artificial para demostrar el timeout.
- **Falso**, para los tests (`tests/soporte/mapas-falso.ts`): un recorrido fijo, y modos que fallan, se cuelgan, tardan o responden fuera de contrato.
- **Timeout y falla cerrado** (`infra/externos/mapas-con-timeout.ts`): envuelve a cualquier adaptador, el simulado o uno real. Con `MAPAS_TIMEOUT_MS` (1 s) o ante cualquier falla, responde `503 MAPAS_NO_DISPONIBLE`. El timeout corta la espera, no el pedido de adentro: un adaptador real tiene que cancelar el suyo, por ejemplo con un `AbortSignal`.

## Decisiones (propuesta implementada; las confirma el equipo)

| # | Decisión | Implementado |
|---|---|---|
| D1 | Fórmula | `max(minimo, bajada + metros × porKm / 1000 + segundos × porMinuto / 60)` |
| D2 | Redondeo | Uno solo, al final del recorrido, mitad hacia arriba, con enteros |
| D3 | Parámetros | Bajada, por km, por minuto, mínimo y máximo, todos en enteros. Moneda `ARS` |
| D4 | Máximo | Más de `maxMetros` da 422 y justo en el máximo se acepta, en la estimación y al crear la solicitud. Ejemplo: 100 km |
| D5 | Distancia cero | Se acepta. Con 0 m y 0 s el total es `max(mínimo, bajada)`; con los valores de ejemplo, el mínimo |
| D6 | Recorrido simulado | Haversine × 1,3, a 25 km/h |
| D7 | Alcance de la tarifa | Global, configurada por el admin (PR 2). Por flota o zona (variante G) sigue como decisión del equipo |
| D8 | Contrato | `GET`, sin Idempotency-Key, para pasajero, operador y admin; desglose y versión |
| D9 | Mapas caído | Timeout de 1 s y 503: falla cerrado |
| D10 | Versión de la tarifa final | La de la estimación: el precio que vio el pasajero queda congelado. Un cambio del admin durante el viaje no lo afecta |
| D11 | Recorrido final | Duración real (de iniciar a finalizar) y la distancia de mapas, que es la de la estimación |
| D12 | Cobro | Automático: finalizar deja el cobro PENDIENTE y lo procesa el barrido; `POST /solicitudes/:id/cobrar` lo hace al instante |

## Tarifa final y cobro

**Al crear la solicitud** (`POST /solicitudes`) se calcula la estimación, con la misma función que `GET /tarifas/estimacion`, **antes** de buscar choferes:
- más de `maxMetros`: `422 VIAJE_FUERA_DE_RANGO`, y no se crea nada;
- mapas caído: `503 MAPAS_NO_DISPONIBLE`, y no se crea nada. No hay viaje sin precio.

La respuesta (y `GET /solicitudes/:id`, el historial y el panel) trae `tarifa`:

```json
"tarifa": {
  "version": "v1",
  "moneda": "ARS",
  "estimadaCentavos": 754220,
  "recorridoEstimado": { "metros": 5209, "segundos": 750 },
  "finalCentavos": null,
  "recorridoFinal": null,
  "motivosDiferencia": []
}
```

**Al iniciar** se guarda la hora (`started_at`): de ahí se mide la duración real.

**Al finalizar**, en la misma transacción que completa el viaje y libera al chofer:
- **la tarifa final**, con la misma `calcularTarifa` y **la misma versión que la estimación** (D10). Si el admin cambió la tarifa durante el viaje, no lo afecta;
- el recorrido final: la **duración real** (de iniciar a finalizar, redondeada al segundo) y la **distancia de mapas**, que es la de la estimación porque el origen y el destino no cambian (D11). Cuando location exponga la distancia recorrida, entra ahí;
- **por qué difiere** (`motivosDiferencia`): `DURACION` y/o `DISTANCIA`, solo si el importe cambió. Si el recorrido cambió pero el importe no (por ejemplo, los dos en el mínimo), queda vacío. La versión nunca es un motivo, porque es siempre la misma;
- **el cobro**, `PENDIENTE`, por la tarifa final. Un solo cobro por viaje: la base lo exige con un índice único;
- el evento `RideCompleted` lleva `tarifaFinalCentavos`.

**El cobro** (D12) no se hace dentro de esa transacción: esperar al proveedor con el viaje bloqueado frenaría todo lo demás. Lo procesa:
- **el barrido**, cada `BARRIDO_INTERVALO_MS` (2 s), sin que nadie lo pida;
- o **`POST /solicitudes/:id/cobrar`**, al instante. Pueden llamarlo el pasajero del viaje, el operador y el admin (otro pasajero: 404; el chofer: 403), con `Idempotency-Key` obligatoria. Si ya está aprobado o rechazado, lo devuelve como está.

`GET /solicitudes/:id` muestra el cobro de un viaje completado:

```json
"cobro": {
  "id": "…", "solicitudId": "…", "pasajeroId": "…",
  "montoCentavos": 754220, "moneda": "ARS",
  "estado": "APROBADO", "intentosFallidos": 0,
  "referencia": "sim-…", "motivoRechazo": null
}
```

**Sin doble cobro.** Dos procesos pueden querer cobrar el mismo viaje a la vez: el barrido y un pedido, o dos reintentos. Dos garantías:
1. **Al proveedor se le pasa siempre la misma clave**: el id del cobro. Como los proveedores reales con su clave de idempotencia, con la misma clave cobra una vez y les devuelve a todos el mismo resultado.
2. **El resultado se registra con el cobro bloqueado** (`SELECT … FOR UPDATE`) **y solo si sigue `PENDIENTE`**: el segundo en llegar ve que ya está resuelto y no registra otro evento.

Test: veinte `POST /cobrar` y el barrido a la vez dan un solo cobro en el proveedor y un solo `PaymentCaptured`. Comprobado que falla si se le pasa al proveedor otra clave en cada intento, o si se saca el `FOR UPDATE`.

**Falla cerrado.** El proveedor va detrás de un timeout (`PAGOS_TIMEOUT_MS`, 1 s), como mapas. Si no contesta, falla o responde fuera de contrato:
- `503 PAGOS_NO_DISPONIBLE`;
- el cobro **sigue `PENDIENTE`**, nunca se lo da por cobrado, y se anotan el intento (`failed_attempts`) y el error;
- el barrido lo reintenta con la misma clave: si el proveedor llegó a cobrar, el reintento recibe ese mismo resultado.

**Un cobro que falla no traba a los demás.** Cada barrido toma hasta 20 pendientes, primero los que hace más que no se intentan (`updated_at`, que cada fallo actualiza). Un cobro que falla pasa al final de la cola. Ordenando por creación, si los 20 más viejos fallaran siempre, se elegirían en cada barrido y los más nuevos no se cobrarían nunca. Test: con el límite en 2 y los dos más viejos fallando, el segundo barrido cobra el tercero. Comprobado que falla ordenando por creación.

**Estados:** `PENDIENTE` → `APROBADO` (evento `PaymentCaptured`) o `RECHAZADO` (evento `PaymentDeclined`, con motivo). Los dos últimos son finales: un rechazo no se reintenta solo.

**Pagos simulado** (`infra/externos/pagos-simulado.ts`): aprueba todo, salvo los importes de más de `PAGOS_RECHAZAR_DESDE_CENTAVOS` (para demostrar un rechazo). `PAGOS_LATENCIA_SIMULADA_MS` agrega una demora, para demostrar el timeout. Recuerda las claves en memoria: un reinicio las olvida, cosa que un proveedor real no haría.

**Persistencia** (migraciones `20261123000000_tarifa_final_cobro` y `20261125000000_importes_bigint_reintentos`):
- en `ride_requests`, la versión, la estimación, la final, los motivos y `started_at`, con `CHECK`s: la estimación va completa o no va, y un viaje con estimación está `COMPLETADA` si y solo si tiene tarifa final;
- la tabla `payments`, con un cobro por viaje (índice único) y `CHECK`s: aprobado o rechazado, siempre con la referencia del proveedor;
- los importes (estimado, final y del cobro) en `BIGINT`. En `INTEGER` el máximo son unos $21 millones, y una tarifa que el admin puede configurar lo pasa: con el tope por km, un viaje de 30 km ya no entraba, la solicitud no se creaba y una tarifa final así deshacía la finalización. `calcularTarifa` nunca devuelve más que `Number.MAX_SAFE_INTEGER`, que entra en `BIGINT`. Test: un viaje de unos 70 km con el tope por km se crea, se completa y se cobra.

Las solicitudes creadas antes de esta migración no tienen tarifa (`null`): se completan sin tarifa final y sin cobro.

## Lo que sigue

- **Abierto:** el alcance por flota o zona (D7), un endpoint para consultar el historial de cambios (hoy queda en `fare_changes`), y el control optimista con `If-Match`.
- **Distancia real:** cuando location exponga la distancia recorrida del viaje, reemplaza a la de mapas en la tarifa final (D11).
- **Reintentos del cobro:** hoy el barrido reintenta un cobro pendiente cada 2 s sin límite. Con un proveedor real, hace falta espaciar los intentos y avisar al operador después de varios fallos.
