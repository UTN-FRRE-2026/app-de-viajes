# Informe de mediciones

Cubre la tarea pesada de 6.6 (location: recepción masiva de ubicaciones y búsqueda de candidatos), la condición de carrera principal (6.3) y las solicitudes de viaje de punta a punta bajo carga y estrés, con el tiempo hasta la asignación ([más abajo](#solicitudes-de-viaje-bajo-carga-y-estrés-66-k6)).

## 6.6 — Ubicaciones: versión ingenua frente a optimizada

### Hipótesis

Escrita el 19/11/2026, **antes** de cualquier medición (ni siquiera las pruebas cortas).

| # | Hipótesis | Número |
|---|---|---|
| H1 | Los pings son más rápidos en la optimizada: un script Lua en Redis contra un `INSERT` con índice en Postgres | p95 de `POST /ubicaciones` **≤ 10 ms** en la optimizada y **al menos el doble** en la ingenua |
| H2 | La búsqueda de la ingenua empeora a medida que crece `pings`, porque `DISTINCT ON` recorre el historial; la optimizada no depende del historial | p95 de `/interno/candidatos`: **> 50 ms** en la ingenua y **< 15 ms** en la optimizada |
| H3 | El trabajo pesado de la ingenua está en Postgres, no en el event loop: el lag y `/health` no deberían cambiar mucho | lag p99 **< 50 ms** y p95 de `/health` **< 20 ms** en las dos |
| H4 | Ninguna versión pierde pings bajo 250 por segundo | errores **< 1 %**; guardados en el historial **=** aceptados en las dos; omitidos por k6 **= 0** en la optimizada |

### Entorno

Entorno aislado de carga (`carga/compose.yml`, proyecto de Compose `viajes-carga`). No comparte base, Redis, credenciales, puertos ni red con el entorno de desarrollo. Ver [carga/README.md](../carga/README.md).

| | |
|---|---|
| Máquina | AMD Ryzen 5 3600 (6 núcleos, 12 hilos), Windows 10 Pro 19045 |
| Docker | Docker Desktop 29.7.2 (motor Linux en WSL 2), VM con 12 CPU y 8 GB |
| location | imagen `node:22-alpine` (Node 22), **1 CPU y 512 MB** de límite, `DB_POOL_MAX=10` |
| Postgres | `postgis/postgis:16-3.4`, 2 CPU y 1 GB |
| Redis | `redis:7-alpine` (7.4), 1 CPU y 512 MB, configuración por defecto |
| k6 | `grafana/k6:1.8.2`, en un contenedor de la misma red, sin límites |
| Otros procesos | Docker Desktop, el Compose de desarrollo (Postgres, Redis y RabbitMQ, sin carga), un identity de desarrollo en el host (sin carga) y el editor |

### Carga y método

- **Pings:** 250 por segundo en modelo abierto (`constant-arrival-rate`). El chofer `i` (de 500) informa cada 2 s, en un recorrido determinista alrededor del Obelisco: la misma secuencia en todas las corridas.
- **Búsquedas:** 20 por segundo en paralelo (`radioMetros=5000`, `limite=10`), con orígenes deterministas.
- **`/health`:** 2 por segundo, como endpoint liviano.
- **Tiempos:** 30 s de calentamiento y **5 minutos** de medición. Qué número cubre qué período: ver [Qué período cubre cada número](#qué-período-cubre-cada-número).
- **Antes de cada corrida:** base y claves de carga vacías, y location reiniciado. El lag se mide desde el arranque.
- **Repeticiones:** 3 corridas por estrategia, alternando ingenua y optimizada.
- **Al terminar:** se espera a que el historial termine de escribirse y se cuentan las filas.

### Comando exacto

```powershell
node carga/preparar.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File carga/medir.ps1 -Estrategia ingenua -Corrida 1
powershell -NoProfile -ExecutionPolicy Bypass -File carga/medir.ps1 -Estrategia optimizada -Corrida 1
node carga/resumir.mjs docs/mediciones/2026-11-19
```

### Resultados

**Tres corridas por estrategia** (ingenua 1, 2 y 3; optimizada 1, 2 y 3), alternadas, el 19/11/2026 entre las 21:39 y las 22:19. Se midió sobre la rama `feat/location-optimizada`, con base `27b619b` y sin commit todavía.

Cada corrida dejó su evidencia en [`docs/mediciones/2026-11-19/`](mediciones/2026-11-19/): resumen de k6, `/metrics`, `docker stats`, conteos y log del apagado. La tabla se arma con `node carga/resumir.mjs docs/mediciones/2026-11-19`.

#### Qué período cubre cada número

Cada corrida tiene **30 s de calentamiento** y **300 s de medición**. k6 etiqueta cada pedido con su fase según el momento en que sale.

| Número | Período | Cómo se separa |
|---|---|---|
| Percentiles (p50, p95, p99) de pings, búsquedas y `/health` | **solo la medición** | submétricas de k6 con la etiqueta `fase:medicion` |
| Tasa de errores | **solo la medición** | `http_req_failed{fase:medicion}` |
| Pings aceptados por segundo | **solo la medición** | aceptados en la medición / 300 s |
| Pings enviados y aceptados | **las dos cosas**, en columnas separadas | `pings_enviados{fase:medicion}` y el total |
| CPU de location, Postgres y Redis | **solo la medición** | muestras de `docker stats` dentro de la ventana de medición (44 o 45 por corrida) |
| Pings omitidos por k6 | **corrida completa** (330 s) | `dropped_iterations` no lleva la etiqueta de fase: k6 no envía el pedido, así que no hay a qué etiquetarlo. En la medición se puede **deducir**: tocaban 250 × 300 = 75 000 envíos, y cada corrida informa cuántos salieron |
| Filas guardadas en el historial | **corrida completa** | Postgres guarda todo lo aceptado, también en el calentamiento. Por eso se compara con los aceptados de la corrida completa |
| Lag del event loop y memoria (RSS) | **desde que arranca location** hasta que termina k6 | `monitorEventLoopDelay` es acumulado y location se reinicia antes de cada corrida: incluye unos segundos sin carga y el calentamiento |

#### Mediana de las 3 corridas por estrategia (solo la medición, salvo donde se indica)

| Métrica | Ingenua | Optimizada |
|---|---|---|
| `POST /ubicaciones` p50 / p95 / p99 | 3452 / **4624** / 5427 ms | 1,3 / **3,7** / 17,2 ms |
| `/interno/candidatos` p50 / p95 / p99 | 3527 / **4668** / 5413 ms | 3,4 / **5,9** / 14,6 ms |
| `/health` p95 / p99 | 4,1 / 10,9 ms | 2,2 / 4,4 ms |
| Pings aceptados por segundo (pedidos: 250) | **140** | **250** |
| Errores | 0,00 % | 0,00 % |
| CPU de location (promedio, de 1 CPU) | 42 % | 42 % |
| CPU de Postgres (promedio) | 19 % | 4 % |
| Lag del event loop p99 / máximo (desde el arranque) | 6,9 / 120,8 ms | 1,9 / 128,5 ms |
| Memoria de location, RSS al final (desde el arranque) | 138 MB | 119 MB |

#### Conteos por corrida

| Corrida | Enviados: medición / completa | Aceptados (204): medición / completa | Omitidos por k6 (completa) | Omitidos en la medición (deducido: 75 000 − enviados) | Con error | Guardados en el historial (completa) | Descartados por cola llena |
|---|---|---|---|---|---|---|---|
| ingenua-1 | 42 126 / 46 899 | 42 126 / 46 899 | 35 602 | 32 874 | 0 | 46 899 | — |
| ingenua-2 | 44 899 / 49 880 | 44 899 / 49 880 | 32 621 | 30 101 | 0 | 49 880 | — |
| ingenua-3 | 37 380 / 42 759 | 37 380 / 42 759 | 39 742 | 37 620 | 0 | 42 759 | — |
| optimizada-1 | 75 000 / 82 501 | 75 000 / 82 501 | 0 | 0 | 0 | 82 501 | 0 |
| optimizada-2 | 75 000 / 82 501 | 75 000 / 82 501 | 0 | 0 | 0 | 82 501 | 0 |
| optimizada-3 | 75 000 / 82 489 | 75 000 / 82 489 | **12** | **0** | 0 | 82 489 | 0 |

- **Omitidos por k6:** son pings que k6 **no llegó a enviar**. Tocaba enviarlos, pero sus usuarios virtuales (hasta 500) estaban todos esperando respuesta. Es lo que mide el modelo abierto.
- **La optimizada omitió 12 pings en una corrida (optimizada-3).** En las otras dos, ninguno. En esa corrida salieron los 75 000 pings previstos para la medición, así que esos 12 corresponden al **calentamiento**: enviados más omitidos da 82 501, lo mismo que en las otras dos.
- **Historial completo en las 6 corridas:** las filas coinciden con los pings aceptados. En la optimizada, además, cada fila tiene un `stream_id` distinto, sin duplicados, y la cola terminó de escribirse entre 22 y 77 ms después de k6.

#### Latencia por corrida (solo la medición)

| Corrida | Pings p95 / p99 (ms) | Búsquedas p95 / p99 (ms) | /health p95 / p99 (ms) | Pings/s | CPU location prom. / máx. (%) | Lag p99 / máx. (ms, desde el arranque) |
|---|---|---|---|---|---|---|
| ingenua-1 | 4624 / 5156 | 4668 / 5146 | 3,8 / 9,0 | 140,4 | 42 / 69 | 6,9 / 120,8 |
| ingenua-2 | 4404 / 5427 | 4524 / 5413 | 4,1 / 55,3 | 149,7 | 43 / 66 | 6,9 / 137,3 |
| ingenua-3 | 6294 / 12 459 | 6368 / 12 581 | 4,7 / 10,9 | 124,6 | 38 / 59 | 6,0 / 95,7 |
| optimizada-1 | 3,7 / 17,2 | 5,9 / 14,6 | 1,8 / 2,7 | 250,0 | 42 / 63 | 1,9 / 128,5 |
| optimizada-2 | 3,4 / 9,0 | 5,6 / 10,3 | 2,2 / 4,4 | 250,0 | 41 / 68 | 1,9 / 124,2 |
| optimizada-3 | 9,7 / 50,5 | 12,4 / 49,5 | 3,1 / 19,9 | 250,0 | 50 / 82 | 8,6 / 161,6 |

#### Por qué se satura la ingenua: el muestreo del WAL

El muestreo apunta a la escritura del WAL de Postgres como causa. Se hizo **en una prueba corta** de la ingenua (5 s + 30 s, con la misma carga), antes de las seis corridas. Cada 0,5 s se registró en qué esperaba cada consulta activa de `location_carga` (`pg_stat_activity`):

| Espera | Muestras (de 508) |
|---|---|
| `LWLock:WALWrite` en `INSERT INTO pings` | 448 |
| `IO:WALSync` en `INSERT INTO pings` | 54 |
| Sin espera (CPU): `SELECT DISTINCT ON` de la búsqueda | 3 |
| Sin espera (CPU): `INSERT` | 2 |
| Otras | 1 |

El archivo con las muestras crudas es [`muestreo-wal-ingenua.txt`](mediciones/2026-11-19/muestreo-wal-ingenua.txt).

En **502 de 508 muestras**, un `INSERT` esperaba la escritura del WAL. Cada ping es una transacción y, con `synchronous_commit=on` y `fsync=on`, cada commit espera su `fsync` en el disco virtual de Docker Desktop.

Lo confirman la CPU baja de Postgres (19 %) y de location (42 %): el límite es la latencia del disco por commit, no el cálculo. Esos `INSERT` ocupan el pool de 10 conexiones, y las búsquedas esperan detrás de ellos. Por eso su latencia es casi igual a la de los pings, aunque su consulta casi no aparece en las muestras.

**Alcance de esta evidencia:** es un muestreo de una prueba corta, no de las seis corridas, y no es una medición directa del tiempo de cada `fsync`. Apunta a la causa con mucha claridad, pero no la mide.

#### Variación entre corridas

La tercera corrida de cada estrategia fue la peor:
- **ingenua-3:** p99 de 12,5 s y solo 125 pings por segundo;
- **optimizada-3:** p99 de unos 50 ms, 12 omitidos en el calentamiento y CPU de location en un 50 % de promedio.

La máquina era la misma y no se lanzó otra carga a propósito. Pero es un Windows de escritorio con Docker Desktop, y además seguía abierto un proceso de identity de desarrollo, sin carga. El ruido de fondo influye. Las otras dos corridas de cada estrategia fueron parecidas entre sí.

### Conclusión

| # | Resultado |
|---|---|
| H1 | **Se cumplió.** Pings p95 de 3,7 ms en la optimizada (mediana de 3 corridas; 9,7 ms en la peor), contra 4624 ms en la ingenua. |
| H2 | **Se cumplió el número, pero no por la causa que supusimos.** La búsqueda de la ingenua dio 4668 ms de p95 (> 50) y la de la optimizada, 5,9 ms (< 15; 12,4 en la peor corrida). Pero la ingenua no se degrada por recorrer el historial con `DISTINCT ON`: el muestreo del WAL indica que espera conexiones del pool, ocupadas por `INSERT` que esperan el `fsync`. |
| H3 | **Se cumplió.** El lag p99 quedó por debajo de 10 ms en todas las corridas, y `/health` por debajo de 5 ms de p95 en las dos versiones. El event loop nunca se trabó: la ingenua es lenta por Postgres, no por bloquear el hilo. Los máximos de lag (~95–160 ms) aparecen en las dos versiones y son picos puntuales, no de la carga sostenida. |
| H4 | **Se cumplió a medias.** No hubo errores, y en las 6 corridas el historial guardó exactamente los pings aceptados, sin duplicados. Pero la ingenua **no sostiene 250 pings por segundo**: en la medición aceptó entre 125 y 150 por segundo, y faltó enviar entre 30 000 y 38 000 de los 75 000 pings previstos. La optimizada envió y aceptó los 75 000 en las tres corridas, pero **omitió 12 pings en el calentamiento** de una de ellas: la hipótesis decía 0. |

**En una frase:** la optimizada cumple la carga de 6.6 con margen, y la ingenua no la alcanza. El costo que la optimizada evita es, según el muestreo, el commit sincrónico de cada ping, no el cálculo de distancias. Coincide con la estrategia elegida en el [ADR 0005](adr/0005-tarea-pesada.md): sacar el ping del pedido HTTP a una cola y escribir en lotes.

**Limitaciones de esta medición:**
- **Es local:** k6 corre en la misma máquina que el sistema, y el disco es el virtual de Docker Desktop. En un servidor con un disco más rápido, la ingenua rendiría más, aunque el commit por ping seguiría siendo su límite.
- **El lag y la memoria no excluyen el calentamiento,** porque se miden desde que arranca location.
- **No mide dispatch** (para eso está la [prueba piloto](#prueba-piloto-una-solicitud-real-bajo-la-carga-de-ubicaciones) de abajo): falta la latencia de la solicitud de viaje y el tiempo hasta la asignación que pide 6.6. Se midieron el 24/11: ver [Solicitudes de viaje bajo carga y estrés](#solicitudes-de-viaje-bajo-carga-y-estrés-66-k6).

## Prueba piloto: una solicitud real bajo la carga de ubicaciones

**22/11, una corrida corta** con `medir.ps1 -Estrategia optimizada -Medicion 60 -Calentamiento 10 -Solicitudes` (el script de entonces; hoy es el escenario A, ver [carga/README.md](../carga/README.md#viajes-en-paralelo-escenario-a)). Es una **prueba piloto de latencia bajo carga**: muestra que el flujo real funciona de punta a punta mientras location absorbe 250 pings/s. No es todavía la medición del informe.

| | Resultado |
|---|---|
| Ventana de las solicitudes | Dentro de la fase de medición de k6: empezó 12 s después de detectar sus pings (2 s después del calentamiento) y terminó a los 66 s, unos 4 s antes del final |
| Iteraciones | 41: crear, oferta por SSE, aceptar, `ASIGNADO` por `GET`, cancelar, `CANCELADO_PASAJERO` por `GET` |
| Asignadas confirmadas por `GET` | **41**, sin ninguna sin asignar, sin `SIN_CHOFERES`, sin ofertas vencidas ni reintentos |
| Incremento del histograma de dispatch | **41: coincide** con las confirmadas por `GET` |
| Tiempo hasta la asignación, en el cliente | p50 **220 ms**, p95 **346 ms**, máximo 444 ms |
| El mismo tiempo, en el servidor | 35 de 41 entre 100 y 250 ms, y 6 entre 250 y 500 ms |
| Ofertas que llegaron antes del 201 | 0 (el script las habría cruzado por `solicitudId`) |
| Lag del event loop de dispatch (desde el arranque) | p50 0,1 ms, p99 0,9 ms, máximo 99 ms. El máximo es del arranque: no se puede separar |
| CPU de dispatch | 7 % de promedio y 10 % de máximo, de 1 CPU |
| Carga de ubicaciones en la misma corrida | 250 pings/s, 0 % de errores, p95 de 6,7 ms y p99 de 38,8 ms |

- **Cliente y servidor:** el tiempo del cliente incluye la entrega de la oferta por el outbox y el SSE: el relay publica cada `RELAY_INTERVALO_MS` (100 ms). Por eso es más alto que el del servidor, que va desde antes de buscar candidatos hasta el COMMIT de la aceptación. El servidor solo da cubetas.
- **Qué se puede concluir:** el camino real funciona bajo la carga de 6.6. La búsqueda contra location, la oferta por SSE, la aceptación y la liberación no fallaron ni una vez, y dispatch casi no tiene lag mientras location recibe los pings: es la evidencia esperada de que separar location protege la asignación.
- **Qué no se puede concluir todavía:**
  - **la disponibilidad ya existe** (PR 1 de flotas: `drivers.available`), **pero dispatch todavía no la usa para filtrar candidatos**. Tampoco filtra por flota ni por zona, porque las zonas en PostGIS están pendientes. El tiempo medido no incluye resolver la zona del origen ni filtrar por flota, zona y disponibilidad, ni los lotes crecientes;
  - un solo flujo con un chofer aislado: **no hay competencia** entre choferes ni entre solicitudes. Es latencia del camino, no capacidad;
  - 60 s de medición en una máquina local: para el informe hay que repetirla con la medición completa, alternada con la ingenua, y con varias solicitudes en paralelo.

## 6.3 — Carrera de la asignación única con k6, contra el sistema en contenedores

**22/11, una corrida de validación** con `carga/carrera.ps1` (ver [carga/README.md](../carga/README.md#carrera-de-la-asignación-única-63)). Reproduce el test `asignacion-unica.test.ts`: 50 choferes aceptan a la vez las 50 ofertas de la misma solicitud. La evidencia está en [mediciones/2026-11-22/carrera-1/](mediciones/2026-11-22/carrera-1/), sin credenciales.

| | Resultado |
|---|---|
| Respuestas | **1×200 y 49×409**, todos `SOLICITUD_NO_DISPONIBLE`. Los 4 checks de k6 pasaron |
| Ganador | El chofer `c…0009`, que también figura en la respuesta del 200 |
| PostgreSQL, antes de cancelar | Solicitud `ASIGNADO` con ese chofer, **una sola fila en `driver_active_assignment` y es la suya**, ofertas en `ACEPTADA: 1, CANCELADA: 49` y un solo `TripAssigned` |
| Después de cancelar | Solicitud `CANCELADO_PASAJERO` y `driver_active_assignment` vacía: el ganador y el pasajero quedaron libres |
| Lote | Las 50 aceptaciones salieron en un solo `http.batch`: 890 ms en total contra 28,8 s de suma de duraciones, así que corrieron superpuestas |

**Límite:** el test fuerza la superposición con una demora dentro de la transacción, y acá no. El resultado no depende de eso: con o sin superposición tiene que ser 1×200 y 49×409.

## Solicitudes de viaje bajo carga y estrés (6.6, k6)

### Hipótesis y umbrales

Escritas el 24/11/2026, **antes** de cualquier corrida de estos escenarios (incluidas las pruebas cortas), y commiteadas antes de correr. Los números del piloto del 22/11 no cuentan: eran un solo viaje por vez y sin el filtro de flotas y zonas.

**Qué cambió desde el piloto:**
- dispatch filtra los candidatos por flota, zona y disponibilidad, con lotes crecientes (PR #36);
- los viajes van en paralelo, con pasajeros y choferes distintos;
- hay competencia: cada viaje se ofrece a 3 choferes, y los que pierden reciben 409.

**Dato que condiciona HS2:** dispatch corta la búsqueda en location a **1 s** (`LOCATION_TIMEOUT_MS`), y el 19/11 la búsqueda de la ingenua dio 4,6 s de p95 con esta misma carga.

#### Escenario A: solicitudes bajo la carga de 6.6 (ingenua frente a optimizada)

**La carga** es la de 6.6, igual que el 19/11: 250 pings/s de los 500 choferes de k6 (el **fondo**), 20 búsquedas/s y `/health`. Además corren:
- **20 pasajeros en paralelo,** en lazo cerrado:
  1. crean el viaje;
  2. esperan `TripAssigned` o `NoDriversFound` en su SSE, hasta 20 s;
  3. lo dejan asignado 1 s;
  4. cancelan;
  5. esperan 1 s y repiten.
- **50 choferes de prueba en Córdoba:**
  - 40 aptos y 10 **no aptos**: 4 inactivos, 3 no disponibles y 3 de una flota que no opera en Córdoba;
  - aceptan enseguida la primera oferta mientras están libres;
  - informan su posición cada 10 s. Son unos **5 pings/s extra**, que se cuentan aparte del fondo.

**El método:** 30 s de calentamiento y 300 s de medición. **Tres corridas por estrategia, alternadas.**

| # | Hipótesis | Número |
|---|---|---|
| HS1 | La optimizada asigna rápido aun con el fondo de 250 pings/s | Tiempo hasta la asignación en el cliente (del `POST` a `TripAssigned`): p95 **≤ 1 s**, p99 **≤ 2 s**. `POST /solicitudes`: p95 **≤ 300 ms**. Errores (5xx, red y 4xx inesperados) **< 1 %** |
| HS2 | La ingenua no llega: su búsqueda pasa el timeout de 1 s, y la solicitud **falla cerrado** | **Más del 50 %** de los `POST /solicitudes` con 503 `UBICACION_NO_DISPONIBLE`. Las que entran tardan más de 1 s. Ninguna queda a medias |
| HS3 | El filtro y la competencia no rompen la corrección | 0 ofertas y 0 asignaciones a los no aptos. Cada viaje asignado tiene un solo chofer. Al final, 0 viajes activos. Todo viaje creado tiene la zona Córdoba, y todo viaje asignado tiene `fleet_id` |
| HS4 | dispatch no traba su event loop | Lag de la ventana de medición: p99 **< 20 ms** en las dos estrategias. CPU de dispatch: promedio **< 60 %** de 1 CPU |

#### Escenario B: rampa de estrés, por escalones (`carga/estres.js`)

**La carga:**
- **El fondo:** los mismos 250 pings/s y 20 búsquedas/s de 6.6 (`ubicaciones.js`), en **un k6 aparte**, así sus usuarios virtuales no se mezclan con los de los pasajeros.
- **Los pasajeros:** k6 crea viajes en modelo abierto, con un escalón por tasa.
  - Las tasas son **1, 2, 4, 8, 16 y 32 viajes/s**, durante 60 s cada una, después de 30 s de calentamiento a 1 viaje/s.
  - Cada usuario virtual es un pasajero distinto: nunca tiene dos viajes activos.
  - Si un viaje no se resuelve en 10 s, se consulta su estado y se cancela si sigue activo, antes de volver a usar ese pasajero.
- **Los choferes de prueba:** 300 aptos y los 10 no aptos, que aceptan enseguida e informan su posición cada 10 s. Son unos **31 pings/s extra**, que se cuentan aparte del fondo.
- **Location:** optimizada.

**La ventana estable de cada escalón:** se descartan los primeros 15 s (la transición) y se mide en los **45 s restantes**. Por escalón se guardan los viajes previstos, los iniciados y los omitidos por k6.

**Una etapa está degradada** si, en su ventana estable, pasa cualquiera de estas cosas:
- `POST /solicitudes` con p95 **> 500 ms**;
- tiempo hasta la asignación con p95 **> 2 s**;
- errores (5xx, red o 4xx inesperados) **> 1 %**;
- viajes omitidos por k6 **> 1 %** de los previstos;
- viajes sin resolver en 10 s, o `NoDriversFound`, **> 1 %**. Hay choferes de sobra, así que indican que la búsqueda o la asignación fallan.

**«Empieza a degradarse»** es la primera etapa degradada. Un umbral incumplido **no corta la corrida**: es justo lo que busca el estrés. La evidencia se guarda igual.

**Tres corridas.**

| # | Hipótesis |
|---|---|
| HE1 | Sostiene **hasta 8 viajes/s** sin degradarse |
| HE2 | La degradación empieza en **16 o 32 viajes/s**, y la limita **dispatch**: 1 CPU, un pool de 10 conexiones, unas 8 transacciones por viaje y el relay del outbox cada 100 ms. No la limita location, que en la optimizada tiene margen |
| HE3 | Antes de la primera etapa degradada, el lag p99 de dispatch en cada ventana queda **< 50 ms**. En la etapa degradada, o sube el lag, o la CPU de dispatch se acerca al 100 % |

**Lo que se informa en los dos escenarios:**
- p50, p95 y p99 en el cliente;
- solicitudes por segundo;
- el tiempo hasta la asignación, en el cliente y en el servidor (por cubeta);
- el lag de dispatch de la ventana (histograma nuevo `event_loop_lag_seconds`, por cubeta);
- la memoria (RSS) de dispatch y de location;
- la CPU por contenedor;
- los 409 esperados por la competencia, los viajes sin resolver y los errores, por separado.

### Resultados

**La tanda:** el 24/11/2026, de 03:40 a 05:05 (hora local), sobre la rama `feat/carga-solicitudes-estres`, en el commit `8da1479`. Las hipótesis ya estaban commiteadas (`1f46053`). Las corridas fueron:
- **escenario A:** ingenua 1, optimizada 1, ingenua 2, optimizada 2, ingenua 3 y optimizada 3, alternadas, y después ingenua 4 en reemplazo de la 2 (ver abajo);
- **escenario B:** estrés 1, 2 y 3.

**El entorno** es el de 6.6 (ver [Entorno](#entorno)), con estos cambios:
- **dispatch de carga:** 1 CPU, 512 MB y `DB_POOL_MAX=10`, en el mismo Postgres, Redis y JWKS;
- el Compose de desarrollo, apagado;
- Docker Desktop 29.7.2 y k6 `grafana/k6:1.8.2`.

```powershell
node carga/preparar.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File carga/medir.ps1 -Estrategia ingenua -Corrida 1 -Fecha 2026-11-24 -Solicitudes
powershell -NoProfile -ExecutionPolicy Bypass -File carga/medir.ps1 -Estrategia optimizada -Corrida 1 -Fecha 2026-11-24 -Solicitudes
powershell -NoProfile -ExecutionPolicy Bypass -File carga/estres.ps1 -Corrida 1 -Fecha 2026-11-24
node carga/resumir.mjs docs/mediciones/2026-11-24
```

**La evidencia** está en [`mediciones/2026-11-24/`](mediciones/2026-11-24/), sin credenciales. Las tablas completas de `resumir.mjs` están en [`tablas.md`](mediciones/2026-11-24/tablas.md), y los checkpoints de Postgres de toda la tanda en [`postgres-checkpoints.txt`](mediciones/2026-11-24/postgres-checkpoints.txt).

**La prueba corta** (30 s por estrategia y estrés con los escalones de 1 y 4 viajes/s) no cuenta para el informe. Su evidencia está en [`mediciones/2026-11-24-prueba-corta/`](mediciones/2026-11-24-prueba-corta/). Dejó todo completo y 0 viajes activos, y sirvió para corregir dos cosas del script, no del sistema:
- los choferes de prueba descartaban las ofertas que llegaban mientras aceptaban otra;
- el cliente reintentaba el 503 `UBICACION_NO_DISPONIBLE`.

#### Una corrida descartada: ingenua 2

Durante `ingenua-2` (03:56 a 04:02), **el disco virtual de Docker se trabó.**
- **El checkpoint de Postgres** de las 06:54 UTC tardó **665 s, de los que 329 s fueron de `fsync`**, con un archivo de hasta 11,3 s. El checkpoint siguiente, todavía dentro de esa corrida, tardó 34 s de `fsync`. En el resto de la tanda, el `fsync` de un checkpoint no pasó de 7,3 s, y ningún archivo tardó más de 2 s.
- **location** se quedó sin CPU (2 %) a los 33 s, mientras su memoria subía de 90 a 240 MB con los pedidos encolados. Postgres también estaba casi sin CPU.
- **k6:** 2.500 pings en 5 min, y el 80 % con timeout de 60 s.

Es una falla del entorno, no de la estrategia, así que **la corrida no cuenta para las latencias**. Se corrió **ingenua 4** en su lugar. La evidencia quedó aparte, en [`mediciones/2026-11-24-descartadas/ingenua-2/`](mediciones/2026-11-24-descartadas/ingenua-2/).

Sirve igual para HS2: con location trabado, dispatch respondió **503 a los 1.007 ms (p50) en los 2.920 intentos**, y no creó ningún viaje. Es la falla cerrada que se esperaba.

#### Escenario A: viajes en paralelo bajo la carga de 6.6

**Por qué difieren los viajes/s:** son 20 pasajeros en **lazo cerrado**, así que cuanto más tarda cada viaje, menos viajes por segundo hay. En la ingenua cada intento termina en 1 s, con un 503, y en la optimizada pasa por la asignación, 1 s asignado y la cancelación.

**Cómo leer los números:**
- **cliente:** percentiles exactos;
- **servidor:** el borde superior de la cubeta;
- **lag:** el de la ventana de medición, con el histograma nuevo.

**Mediana de las 3 corridas por estrategia:**

| Estrategia | Viajes/s | `POST /solicitudes` p50 / p95 / p99 (ms) | Hasta la asignación p50 / p95 / p99 (ms) | 503 ubicación | Lag dispatch p99 | CPU dispatch prom. | RSS dispatch / location |
|---|---|---|---|---|---|---|---|
| ingenua | 9,93 | 1.007 / 1.010 / 1.021 | — (ninguno asignado) | **100 %** | ≤ 2 ms | 12 % | 122 / 147 MB |
| optimizada | 7,38 | **88 / 243 / 482** | **291 / 566 / 8.546** | 0 % | ≤ 10 ms | 37 % | 137 / 117 MB |

**Por corrida:**

| Corrida | Viajes/s | `POST` p50 / p95 / p99 (ms) | Asignación, cliente p50 / p95 / p99 (ms) | Asignación, servidor p50 / p95 / p99 | 503 / sin resolver / errores | Lag dispatch p99 | CPU dispatch prom. / máx | Pings/s: fondo / choferes de prueba |
|---|---|---|---|---|---|---|---|---|
| ingenua-1 | 9,93 | 1.007 / 1.010 / 1.022 | — | — | 2.920 / 0 / 0 | ≤ 2 ms | 13 / 36 % | 122 / 3,6 |
| ingenua-3 | 9,93 | 1.007 / 1.011 / 1.021 | — | — | 2.920 / 0 / 0 | ≤ 2 ms | 12 / 34 % | 125 / 3,6 |
| ingenua-4 | 9,93 | 1.007 / 1.010 / 1.019 | — | — | 2.920 / 0 / 0 | ≤ 2 ms | 11 / 40 % | 124 / 3,6 |
| optimizada-1 | 5,00 | 103 / 3.095 / 9.259 | 337 / 5.749 / 17.521 | ≤ 0,5 / ≤ 10 / ≤ 30 s | 4 / 4 / 0 | ≤ 10 ms | 35 / 81 % | 250 / 5 |
| optimizada-2 | 7,85 | 86 / 212 / 335 | 280 / 478 / 944 | ≤ 0,25 / ≤ 0,5 / ≤ 1 s | 0 / 0 / 0 | ≤ 5 ms | 37 / 66 % | 250 / 5 |
| optimizada-3 | 7,38 | 88 / 243 / 482 | 291 / 566 / 8.546 | ≤ 0,25 / ≤ 0,5 / ≤ 10 s | 0 / 0 / 0 | ≤ 10 ms | 39 / 60 % | 250 / 4,9 |

- **Fondo y choferes de prueba:** el fondo son los pings/s de k6 que location aceptó en la medición; los de los choferes de prueba van aparte. Con la ingenua, el fondo no llega a 250, como el 19/11: k6 omite unos 40.000 pings por corrida.
- **Las ubicaciones de 6.6, en estas mismas corridas,** repiten lo del 19/11 (ver [`tablas.md`](mediciones/2026-11-24/tablas.md)):
  - **pings p95:** 4.702 ms en la ingenua y 6,8 ms en la optimizada;
  - **búsquedas p95:** 4.653 ms y 7,1 ms;
  - **pings/s:** 124 y 250.

**Competencia y corrección.** Las 6 corridas dieron 0 en todo esto:
- ofertas a no aptos, por SSE y en la base;
- viajes de no aptos;
- viajes fuera de Córdoba;
- asignados sin flota;
- viajes activos al final.

| Corrida | Iteraciones | Ofertas recibidas | Aceptadas (200) | 409 esperados (`SOLICITUD_NO_DISPONIBLE`) | Errores al aceptar |
|---|---|---|---|---|---|
| optimizada-1 | 1.558 | 4.743 | 1.552 | 2.311 | 0 |
| optimizada-2 | 2.356 | 7.110 | 2.356 | 3.740 | 0 |
| optimizada-3 | 2.323 | 7.020 | 2.323 | 3.730 | 0 |

En `optimizada-1` hay 2 aceptadas más que asignadas en el cliente: son 2 de los 4 viajes que vencieron la espera de 20 s, se asignaron después y se liberaron al cancelar.

**De dónde sale la cola del p99,** por los viajes de más de 2 s:
- **`optimizada-2`:** 14 de 2.356 (0,6 %), **todos entre 14 y 18 s**. Es el TTL de la oferta. Cada viaje se ofrece a 3 choferes, y si los 3 ya tomaron otro viaje, la oferta queda pendiente hasta que vence a los 15 s y se ofrece de nuevo.
- **`optimizada-3`:** 29 (1,25 %), 16 de ellos por el TTL.
- **`optimizada-1`:** 181 (11,7 %), repartidos entre 2 y más de 18 s, con 4 timeouts de location y 4 viajes sin resolver.

  Se concentran entre las 03:53 y las 03:54. En ese minuto, **dispatch y Postgres bajan a 1-6 % de CPU** mientras los pedidos esperan, y dispatch registra «Unable to start a transaction in the given time»: el pool esperaba a una base que no avanzaba, sin que nadie estuviera ocupado.

  Es el mismo tipo de pausa del disco que trabó `ingenua-2`, más corta.

#### Escenario B: estrés por escalones

Ventana estable de cada escalón (45 s). Cada celda es **corrida 1 / corrida 2 / corrida 3**.

| Tasa (viajes/s) | Logrado (viajes/s) | `POST` p95 (ms) | Asignación p95, cliente (ms) | Omitidos por k6 (de los previstos en la etapa) | Sin resolver | CPU dispatch / Postgres / location (%) | Lag dispatch p99 | ¿Degradada? |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 / 1 / 1,02 | 120 / 167 / 110 | 336 / 378 / 335 | 0 / 0 / 0 (de 60) | 0 / 0 / 0 | 17 / 18 / 11 · 6-8 · 55-63 | ≤ 2 ms | no / no / no |
| 2 | 2 / 2,02 / 2,02 | 169 / 184 / 152 | 383 / 377 / 376 | 0 / 0 / 0 (de 120) | 0 / 0 / 0 | 17 / 17 / 14 · 11-13 · 55-64 | ≤ 2 ms | no / no / no |
| 4 | 4 / 4,02 / 4,02 | 151 / 144 / 208 | 377 / 377 / 454 | 0 / 0 / 0 (de 240) | 0 / 0 / 0 | 26 / 26 / 31 · 11-13 · 62-65 | ≤ 2 ms | no / no / no |
| 8 | 7,98 / 7,98 / 5,33 | 141 / 417 / **9.307** | 371 / 811 / **9.662** | 0 / 2 / **134** (de 480) | 0 / 0 / **34** | 45 / 48 / 19 · 11-18 · 49-61 | ≤ 5 / ≤ 5 / ≤ 100 ms | no / no / **sí** |
| 16 | 15,67 / 15,42 / 16,02 | **1.028 / 1.515** / 249 | **2.334 / 3.079** / 530 | **15 / 26** / 8 (de 960) | 2 / 3 / 0 | **84 / 77 / 75** · 25-29 · 52-61 | ≤ 100 ms | **sí / sí** / no |
| 32 | 17,29 / 19,16 / 18,67 | **5.157 / 4.705 / 6.093** | — / **10.821 / 10.778** | **893 / 714 / 710** (de 1.920) | **778 / 792 / 694** | **78 / 90 / 82** · 24-30 · 61-69 | ≤ 100 ms | **sí / sí / sí** |

- **Sin `NoDriversFound`, 503 ni errores** en ninguna ventana estable de las 3 corridas.
- **Los pings a location** fueron estables en todos los escalones: **277,6/s**, de los que **27,6/s** son de los choferes de prueba. Los 250/s del fondo no cambiaron con la tasa de viajes.
- **La memoria (RSS):**
  - **dispatch** subió de 131-141 MB en 1 viaje/s a 165-166 MB en 32;
  - **location** quedó entre 122 y 150 MB.
- **«Logrado» en 32 viajes/s** no pasa de 17 a 19 viajes/s: el resto lo omite k6, porque no hay usuarios virtuales libres mientras cada viaje tarda más de 10 s.
- **En 32 viajes/s de la corrida 1 no se asignó ninguno dentro de la ventana:** los 778 iniciados quedaron sin resolver en 10 s.
- **Las primeras etapas degradadas:** **16 viajes/s** en las corridas 1 y 2, y **8 viajes/s** en la 3.

**La corrida 3 en 8 viajes/s.** No es saturación de CPU, es una pausa del entorno:
- **dispatch y Postgres** promediaron 19 % y 11 % de CPU, con muestras de dispatch de 0,5 % mientras los `POST` tardaban 3,5 s de mediana;
- **en el mismo momento, location** también se atrasó: lag p95 de 50 ms contra 2-5 ms en las otras etapas, y menos muestras del temporizador (434 de 450);
- **dispatch** registró «Unable to start a transaction in the given time» a las 07:52:15 UTC, al final de esa ventana;
- **el escalón siguiente, 16 viajes/s, pasó todos los criterios en esa misma corrida.**

Que el atraso pegue a la vez en dos procesos con CPU libre apunta a la máquina virtual de Docker, no a dispatch. Pero la corrida se informa como está: es una pausa que también podría pasar en producción.

**Los viajes activos al final de `estres-1`: 15.** Son iteraciones que k6 cortó al terminar el escalón de 32 viajes/s:
- k6 inició 2.906 iteraciones y completó 2.886;
- al cerrar cada escenario, k6 espera 15 s (`gracefulStop`), y en ese escalón un viaje tardaba 4 s en crearse y hasta 10 s en resolverse, antes de cancelar.

Los 15 quedaron `ASIGNADO`, con su asignación activa (15 = 15): el cliente se cortó y no llegó a cancelar. No hay viajes con dos choferes ni asignaciones sueltas.

En las corridas 2 y 3, k6 completó todas las iteraciones y no quedó ninguno activo.

En las 3 corridas hubo 0 ofertas y 0 viajes para los no aptos, 0 viajes fuera de Córdoba y 0 asignados sin flota.

**Errores fuera de las ventanas estables:** solo en `estres-1`, 37 en total, en las transiciones y en el cierre. Entre ellos, 6 respuestas 500 de dispatch por «Unable to start a transaction in the given time»: el pool de 10 conexiones agotado.

#### Conclusión de cada hipótesis

| # | Resultado | Por qué |
|---|---|---|
| HS1 | **Se cumple, salvo el p99** | Mediana de la optimizada: `POST` p95 **243 ms** (≤ 300) y asignación p95 **566 ms** (≤ 1 s). Errores: ninguno en las 3 corridas, salvo 4 respuestas 503 en `optimizada-1` (0,26 %, < 1 %). **El p99 de la asignación (8,5 s) no cumple ≤ 2 s:** solo `optimizada-2` lo cumple (944 ms). La cola tiene dos causas: el TTL de 15 s de las ofertas a choferes que ya tomaron otro viaje (14 a 18 s, el 0,6 % de los viajes), que es del diseño, y pausas del entorno (`optimizada-1`) |
| HS2 | **Se cumple** | En las 3 corridas, el **100 %** de los `POST /solicitudes` respondió 503 `UBICACION_NO_DISPONIBLE`, en **1.007 ms** de mediana (el timeout de 1 s). Ningún viaje creado y ninguno activo: falla cerrado. Con la ingenua no se asigna ningún viaje bajo la carga de 6.6 |
| HS3 | **Se cumple en el escenario A. En B, con una salvedad** | 0 ofertas y 0 viajes a no aptos, 0 fuera de Córdoba y 0 asignados sin flota en las 9 corridas. Competencia: **entre 2.311 y 3.740 409 `SOLICITUD_NO_DISPONIBLE` por corrida**, ningún error al aceptar, y cada viaje con una sola aceptación. Al final, 0 activos en las 6 corridas de A y en 2 de las 3 de B. Los 15 de `estres-1` son iteraciones que k6 cortó en el cierre de 32 viajes/s antes de cancelar, no una falla de dispatch |
| HS4 | **Se cumple** | Lag de dispatch en la ventana: p99 **≤ 10 ms** (cubeta) en la optimizada y **≤ 2 ms** en la ingenua, < 20 ms. CPU de dispatch: **37 %** de promedio en la optimizada y 12 % en la ingenua, < 60 % |
| HE1 | **Se cumple en 2 de 3 corridas** | Las corridas 1 y 2 sostienen 8 viajes/s, con `POST` p95 de 141 y 417 ms y asignación p95 de 371 y 811 ms. La corrida 3 se degrada en 8 viajes/s por una pausa del entorno con la CPU libre, y vuelve a cumplir en 16 viajes/s |
| HE2 | **Se cumple** | La degradación empieza en **16 viajes/s** (corridas 1 y 2), y en 32 viajes/s se degradan las 3: el sistema no pasa de **17 a 19 viajes/s**. **El límite es dispatch:** 77-90 % de su CPU en 16 y 32 viajes/s, y el pool de 10 conexiones agotado en las corridas 1 y 3 («Unable to start a transaction in the given time»). **No es location:** 52-69 % de CPU, 0 timeouts (0 503) y pings estables. **Capacidad en esta máquina: unos 8 viajes/s con margen, y entre 15 y 16 sostenidos con la latencia ya degradada** |
| HE3 | **Se cumple** | Antes de la primera etapa degradada, el lag p99 de dispatch es **≤ 5 ms** en las 3 corridas (< 50 ms). En las etapas degradadas por carga sube a la cubeta de **50-100 ms**, con la CPU de dispatch en 75-90 %. En la pausa de la corrida 3, el lag también sube, pero con la CPU baja |

**Qué se puede concluir:**
- **La optimizada habilita la asignación bajo la carga de 6.6, y la ingenua no:** con la ingenua, todas las solicitudes fallan cerrado a 1 s. Con la optimizada, el 95 % de los viajes se asigna en menos de 0,6 s.
- **El cuello de botella siguiente es dispatch, no location:** su CPU y su pool de conexiones. Para pasar de unos 16 viajes/s, lo primero sería más CPU o réplicas de dispatch, y un pool más grande que acompañe a Postgres. Location tiene margen.
- **El p99 de la asignación lo marca el TTL de la oferta,** no la búsqueda. Una oferta a un chofer ocupado espera 15 s. Bajarlo cambiaría el producto (el chofer tiene menos tiempo para aceptar), así que se informa como está.

**Limitaciones:**
- **Es local:** k6, los servicios y Postgres comparten la máquina y el disco virtual de Docker Desktop. Las pausas de `ingenua-2`, `optimizada-1` y `estres-3` muestran que ese disco agrega ruido, y en una máquina dedicada habría menos.
- **Los choferes de prueba no tienen tiempo de reacción:** aceptan enseguida. Se mide el sistema, no a las personas.
- **Resolución:**
  - en el estrés, el tiempo hasta la asignación en el cliente tiene una resolución de ±100 ms, por la consulta cada 100 ms;
  - el servidor y el lag se informan por cubeta, así que «≤ 100 ms» significa entre 50 y 100 ms.
- **Tres corridas por escenario** alcanzan para ver la tendencia, pero no para dar intervalos de confianza.
