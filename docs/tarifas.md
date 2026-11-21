# Tarifas (dispatch)

Estado: **cálculo y estimación** (PR 1). La configuración por el admin (PR 2), la tarifa final, por qué difiere de la estimación y el cobro (PR 3) vienen después. Ver [Lo que sigue](#lo-que-sigue).

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
- **El máximo no es parte del cálculo.** `exigirDentroDeRango` rechaza un recorrido de más de `maxMetros`. **En este PR se aplica a la estimación** (`422 VIAJE_FUERA_DE_RANGO`). Crear una solicitud todavía no lo exige: si también se aplica ahí, se decide en el PR 3. `calcularTarifa` nunca rechaza: un viaje que ya terminó siempre tiene que poder cobrarse, aunque el recorrido real haya salido más largo.

Código:
- `services/dispatch/src/dominio/tarifas/calculo.ts`: `calcularTarifa` y `exigirDentroDeRango`;
- `services/dispatch/src/dominio/tarifas/parametros.ts`: parámetros e invariantes.

La tarifa final del PR 3 tiene que usar **la misma** `calcularTarifa`.

## Parámetros

| Parámetro | Variable | Ejemplo | Regla |
|---|---|---|---|
| Bajada de bandera | `TARIFA_BAJADA_CENTAVOS` | 150000 ($1500) | entero, 0 a 100 000 000 |
| Por km | `TARIFA_CENTAVOS_POR_KM` | 80000 ($800) | entero, 0 a 100 000 000 |
| Por minuto | `TARIFA_CENTAVOS_POR_MINUTO` | 15000 ($150) | entero, 0 a 100 000 000 |
| Mínimo | `TARIFA_MINIMO_CENTAVOS` | 250000 ($2500) | entero, 0 a 100 000 000 |
| Recorrido máximo | `TARIFA_MAX_METROS` | 100000 (100 km) | entero, 1 a 1 000 000 |

Moneda fija: `ARS`. Si un valor no cumple, dispatch no arranca y nombra la variable.

**En contenedores**, `docker-compose.yml` le pasa a dispatch las variables `TARIFA_*` y `MAPAS_*` del `.env`. Si una no está, llega vacía. Dispatch trata un valor vacío o con solo espacios como ausente: usa su valor por defecto, nunca 0. Un `0` escrito a propósito sigue valiendo 0 en los importes que lo admiten. Los valores por defecto se definen en un solo lugar, `services/dispatch/src/config/index.ts`.

**Versión.** Hoy la tarifa sale del `.env` y su versión es una huella de los valores: `env-` seguido de 12 caracteres hexadecimales. Si cambian los valores, cambia la versión. La estimación la devuelve, para que el PR 3 pueda explicar una diferencia por un cambio de tarifa.

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
  "tarifaVersion": "env-3e0fb9a6f2d0"
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
| D4 | Máximo | En la estimación, más de `maxMetros` da 422 y justo en el máximo se acepta. Ejemplo: 100 km. Al crear la solicitud todavía no se aplica (PR 3) |
| D5 | Distancia cero | Se acepta. Con 0 m y 0 s el total es `max(mínimo, bajada)`; con los valores de ejemplo, el mínimo |
| D6 | Recorrido simulado | Haversine × 1,3, a 25 km/h |
| D7 | Alcance de la tarifa | Global. Por flota o zona (variante G) queda abierto para el PR 2 |
| D8 | Contrato | `GET`, sin Idempotency-Key, para pasajero, operador y admin; desglose y versión |
| D9 | Mapas caído | Timeout de 1 s y 503: falla cerrado |

## Lo que sigue

- **PR 2: configuración por el admin.**
  - Tarifa versionada en Postgres, con `GET` y `PUT /admin/tarifas` solo para `admin`.
  - El `PUT` lleva `Idempotency-Key`.
  - Auditoría de quién cambió qué.
  - Caché en Redis con invalidación al editar.
  - Alcance por flota o zona, si el equipo lo decide (D7).
  - El `ProveedorTarifas` pasa a leer la tabla, y los valores del `.env` quedan como semilla.
- **PR 3: tarifa final y cobro.**
  - Al crear la solicitud se guarda la estimación con su versión.
  - Al finalizar se calcula la tarifa final con la misma función.
  - Se guarda por qué difieren: otra versión de tarifa, u otro recorrido.
  - Se cobra con un puerto de pagos, idempotente y con falla cerrado.
  - Hay que decidir si una solicitud fuera de rango se rechaza al crearla.
