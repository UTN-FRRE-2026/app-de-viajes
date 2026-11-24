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

**Corrección del 24/11, antes de la segunda tanda.** La primera versión de estas hipótesis decía que los choferes de prueba informaban su posición cada 10 s (unos 5 y 31 pings/s extra). El plan aprobado decía cada 2 s, que es también la cadencia de los 500 choferes de k6 y el mínimo entre envíos de la pantalla del chofer. Además, cada chofer esperaba la respuesta antes de esperar los 10 s, y todos arrancaban dentro del mismo segundo, así que los pings salían en ráfagas. La primera tanda se hizo así, y por eso se repitió (ver [Resultados](#resultados-1)). **Los umbrales y las hipótesis no cambian:** solo la cadencia de los choferes de prueba.

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
  - informan su posición **cada 2 s**, a tasa fija y con las fases repartidas en el intervalo, como los choferes de k6. Son unos **25 pings/s extra**, que se cuentan aparte del fondo (ver la corrección de abajo).

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
- **Los choferes de prueba:** 300 aptos y los 10 no aptos, que aceptan enseguida e informan su posición **cada 2 s**. Son unos **155 pings/s extra**, que se cuentan aparte del fondo (ver la corrección de abajo).
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

**La tanda que cuenta:** el 24/11/2026, de 05:28 a 06:37 (hora local), sobre la rama `feat/carga-solicitudes-estres`, en el commit `4dae036`. Las hipótesis ya estaban commiteadas (`1f46053`), con la corrección de la cadencia de los choferes de prueba. Las corridas fueron, en este orden:
- **escenario A:** ingenua 1, optimizada 1, ingenua 2, optimizada 2, ingenua 3 y optimizada 3, alternadas;
- **escenario B:** estrés 1, 2 y 3.

No se reemplazó ninguna corrida de esta tanda. Las 9 terminaron completas, con 0 viajes activos al final.

**El entorno** es el de 6.6 (ver [Entorno](#entorno)), con estos cambios:
- **dispatch de carga:** 1 CPU, 512 MB y `DB_POOL_MAX=10`, en el mismo Postgres, Redis y JWKS;
- el Compose de desarrollo, apagado;
- Docker Desktop 29.7.2 y k6 `grafana/k6:1.8.2`;
- **el disco de Docker:** los datos de Docker Desktop (y con ellos el volumen de Postgres) están en `F:\Docker\DockerData`, y F: es un **disco mecánico** (Seagate ST2000DM008, 2 TB). Se descubrió en esta revisión: ver [El disco de Docker](#el-disco-de-docker-pausas-de-15-a-25-s-con-la-cpu-libre).

```powershell
node carga/preparar.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File carga/medir.ps1 -Estrategia ingenua -Corrida 1 -Fecha 2026-11-24 -Solicitudes
powershell -NoProfile -ExecutionPolicy Bypass -File carga/medir.ps1 -Estrategia optimizada -Corrida 1 -Fecha 2026-11-24 -Solicitudes
powershell -NoProfile -ExecutionPolicy Bypass -File carga/estres.ps1 -Corrida 1 -Fecha 2026-11-24
node carga/resumir.mjs docs/mediciones/2026-11-24
```

**La evidencia** está en [`mediciones/2026-11-24/`](mediciones/2026-11-24/), sin credenciales:
- las tablas completas de `resumir.mjs`, en [`tablas.md`](mediciones/2026-11-24/tablas.md);
- los checkpoints de Postgres de toda la tanda, en [`postgres-checkpoints.txt`](mediciones/2026-11-24/postgres-checkpoints.txt);
- la sonda del disco, en [`sonda-commit/`](mediciones/2026-11-24/sonda-commit/);
- la carrera de 6.3, repetida con los datos nuevos, en [`carrera-1/`](mediciones/2026-11-24/carrera-1/).

#### Antes de esta tanda: lo que se descartó y por qué

**1. La primera tanda (03:40 a 05:05) no cuenta.** Su evidencia quedó en [`mediciones/2026-11-24-pings-cada-10s/`](mediciones/2026-11-24-pings-cada-10s/). Los choferes de prueba informaban su posición **cada 10 s, no cada 2 s** como decía el plan, y por eso aportaron 5 y 27,6 pings/s en vez de 25 y 155:
- **escenario A:** 50 choferes activos, entre 1.700 y 1.750 pings enviados por corrida, todos aceptados (204). 50 / 10 s = **5 pings/s**. Con la ingenua bajaba a 3,6/s, porque cada chofer esperaba la respuesta (unos 4 s) antes de esperar los 10 s;
- **escenario B:** 310 choferes activos, 13.020 pings enviados por corrida, todos aceptados. Son 31/s de promedio, pero **todos arrancaban en el mismo segundo**, así que los pings salían en ráfagas de 310: en cada ventana de 45 s entraban 4 ráfagas, y 4 × 310 / 45 = **27,6/s**.

Location recibía unos 255 pings/s en A y unos 281 en B, en vez de 275 y 405: la carga sobre location estaba subestimada, justo lo que hace falta para decir dónde se satura el sistema. Se corrigió el script (un ping cada 2 s, a tasa fija y con las fases repartidas en el intervalo) y se repitieron los dos escenarios. En la prueba corta posterior ([`2026-11-24-prueba-corta-2/`](mediciones/2026-11-24-prueba-corta-2/)): 50 de 50 choferes activos con 25 pings/s enviados y aceptados en A, y 310 de 310 con 154,5/s en B.

**2. En la primera tanda, `ingenua-2` se reemplazó tras observar una pausa del disco.** El checkpoint de Postgres de las 06:54 UTC tardó 665 s, de los que **329 s fueron de `fsync`**. location se quedó sin CPU y k6 vio el 80 % de los pings con timeout de 60 s. Se corrió `ingenua-4` en su lugar, y la evidencia de la descartada quedó en [`descartada-ingenua-2/`](mediciones/2026-11-24-pings-cada-10s/descartada-ingenua-2/). Igual sirvió para HS2: 503 a los 1.007 ms en los 2.920 intentos, sin ningún viaje creado.

**3. En la primera tanda, `estres-1` terminó con 15 viajes activos.** Eran iteraciones que k6 cortó al cerrar el escalón de 32 viajes/s: k6 espera 15 s (`gracefulStop`), y un viaje tardaba 4 s en crearse y hasta 10 s en resolverse antes de cancelar. Los 15 quedaron `ASIGNADO` con su asignación activa (15 = 15), sin viajes con dos choferes ni asignaciones sueltas. **El último escalón ahora espera 40 s**, y en esta tanda las 3 corridas de estrés terminaron con **0 viajes activos**.

**4. `carrera.ps1` se volvió a correr después del cambio en los datos de carga** (los tokens de 400 pasajeros y 310 choferes, y los no aptos de `flotas.sql`). **Pasa:** 1 × 200 y 49 × 409 `SOLICITUD_NO_DISPONIBLE`, una sola asignación activa (la del ganador), y al cancelar quedan libres el ganador y el pasajero.

#### El disco de Docker: pausas de 15 a 25 s con la CPU libre

En 5 de las 9 corridas hay tramos de 15 a 25 s en que **dispatch y Postgres bajan a 0-6 % de CPU mientras location sigue normal (45-55 %)**, y los pedidos de dispatch esperan. No es saturación: nadie está ocupado.

| Corrida | Cuándo (hora local) | Carga en ese momento | Efecto |
|---|---|---|---|
| `optimizada-2` | 05:56:24 | unos 8 viajes/s | 6 viajes de más de 2 s (menos de 1 s de pausa) |
| `optimizada-3` | 06:10:42 a 06:11:04 | unos 8 viajes/s | 58 viajes de 2 a 5 s, 1 sin resolver y 1 «Unable to start a transaction» |
| `estres-1` | 06:18:08 a 06:18:29 | escalón de 16 viajes/s | — (el escalón se degrada igual, ver abajo) |
| `estres-2` | 06:25:19 a 06:26:23 | escalón de 8 viajes/s, y el comienzo del de 16 | el escalón de 8 se degrada; 3 «Unable to start a transaction» |
| `estres-3` | 06:35:11 a 06:35:25 | escalón de 16 viajes/s | 2 «Unable to start a transaction» |

**La causa es el disco, medida directamente.** Con todo quieto (sin k6, sin dispatch ni location), una sonda hizo un `INSERT` con su `COMMIT` cada 200 ms en el mismo Postgres, durante 5 min ([`sonda-commit/`](mediciones/2026-11-24/sonda-commit/)):

| Commits | p50 | p95 | p99 | Máx. | De más de 1 s |
|---|---|---|---|---|---|
| 700 | 65 ms | 1.173 ms | 2.594 ms | 4.380 ms | 52, casi todos entre las 09:43:54 y las 09:46:36 UTC |

En un SSD, un commit tarda menos de 5 ms. Cada viaje de dispatch hace unas 8 transacciones, y todas esperan el `fsync` del WAL. Cuando el disco se atrasa, las 10 conexiones del pool quedan esperando su commit con los locks tomados, el resto de los pedidos espera una conexión (hasta 10 s, `maxWait`), y Postgres no tiene nada que calcular. location responde el ping sin esperar a Postgres (el historial se escribe en segundo plano, con una cola), por eso sigue.

**Por qué no se reemplazaron esas corridas:** las pausas no son un hecho aislado, como el checkpoint de 329 s de la primera tanda, sino una propiedad del disco durante toda la tanda. Repetir una corrida solo las movería de lugar, y quedarse con las que no tuvieron pausas sesgaría los resultados. Se informan como están, y se separa su efecto con una prueba corta:

**Prueba corta con commit asíncrono** ([`2026-11-24-commit-asincrono/`](mediciones/2026-11-24-commit-asincrono/), no cuenta para el informe). Es el mismo estrés, con los escalones de 8, 16 y 32 viajes/s y una sola corrida, pero con `synchronous_commit = off` en el Postgres de carga: los commits ya no esperan el `fsync` del disco. Se volvió a `on` al terminar.

| Tasa (viajes/s) | Intentos / asignados (por s) | `POST` p95 (ms) | Asignación p95 (ms) | Omitidos por k6 | Sin resolver | CPU dispatch / Postgres / location (%) | Lag dispatch p99 | ¿Degradada? |
|---|---|---|---|---|---|---|---|---|
| 8 | 8,02 / 8,02 | 82 | 262 | 0 de 480 | 0 | 42 / 22 / 95 | ≤ 5 ms | no |
| 16 | 16,02 / 16,02 | 179 | 415 | 0 de 960 | 0 | 83 / 37 / 100 | ≤ 100 ms | **no** |
| 32 | 19,11 / 0 | 4.377 | — | 711 de 1.920 | 860 | 98 / 33 / 98 | ≤ 100 ms | sí |

Sin esperar al disco, **16 viajes/s pasa todos los criterios**, y la degradación empieza recién en 32, con dispatch al 98 % de CPU. Con el disco mecánico, en cambio, 16 viajes/s se degradó en las 3 corridas con dispatch al 47-51 %. Además, location sube a 95-100 % de CPU en esta prueba: ya no espera al disco para escribir el historial, y llega a su propio límite de 1 CPU.

#### Escenario A: viajes en paralelo bajo la carga de 6.6

**Intentos, creados y asignados** se separan: un **intento** es cada `POST /solicitudes`; **creado**, el que respondió 201; **asignado**, el que llegó a `TripAssigned`. Son 20 pasajeros en **lazo cerrado**, así que cuanto más tarda cada viaje, menos intentos por segundo hay: en la ingenua cada intento termina en 1 s, con un 503, y en la optimizada pasa por la asignación, 1 s asignado y la cancelación.

**Cómo leer los números:**
- **cliente:** percentiles exactos;
- **servidor:** el borde superior de la cubeta;
- **lag:** el de la ventana de medición, con el histograma nuevo.

**Mediana de las 3 corridas por estrategia:**

| Estrategia | Intentos/s | Creados/s | Asignados/s | `POST /solicitudes` p50 / p95 / p99 (ms) | Hasta la asignación p50 / p95 / p99 (ms) | 503 ubicación (% de los intentos) | Lag dispatch p99 | CPU dispatch prom. | RSS dispatch / location |
|---|---|---|---|---|---|---|---|---|---|
| ingenua | 9,93 | **0** | **0** | 1.007 / 1.012 / 1.026 | — (ninguno asignado) | **100 %** | ≤ 2 ms | 13 % | 123 / 171 MB |
| optimizada | 7,86 | 7,86 | 7,86 | **87 / 249 / 530** | **277 / 581 / 1.835** | 0 % | ≤ 5 ms | 42 % | 138 / 123 MB |

Los 9,93/s de la ingenua son **intentos**: los 2.920 de cada corrida respondieron 503 `UBICACION_NO_DISPONIBLE`, y no se creó ni se asignó ningún viaje.

**Por corrida:**

| Corrida | Intentos / creados / asignados (por s) | `POST` p50 / p95 / p99 (ms) | Asignación, cliente p50 / p95 / p99 (ms) | Asignación, servidor p50 / p95 / p99 | 503 / sin resolver / errores | Lag dispatch p99 | CPU dispatch prom. / máx |
|---|---|---|---|---|---|---|---|
| ingenua-1 | 9,93 / 0 / 0 | 1.008 / 1.012 / 1.027 | — | — | 2.920 / 0 / 0 | ≤ 2 ms | 13 / 40 % |
| ingenua-2 | 9,93 / 0 / 0 | 1.007 / 1.012 / 1.026 | — | — | 2.920 / 0 / 0 | ≤ 2 ms | 14 / 40 % |
| ingenua-3 | 9,93 / 0 / 0 | 1.007 / 1.011 / 1.022 | — | — | 2.920 / 0 / 0 | ≤ 2 ms | 12 / 37 % |
| optimizada-1 | 8,01 / 8,01 / 8,01 | 87 / 232 / 437 | 285 / 515 / 1.118 | ≤ 0,25 / ≤ 0,5 / ≤ 1 s | 0 / 0 / 0 | ≤ 5 ms | 46 / 81 % |
| optimizada-2 | 7,86 / 7,86 / 7,86 | 87 / 249 / 530 | 277 / 581 / 1.835 | ≤ 0,25 / ≤ 0,5 / ≤ 1 s | 0 / 0 / 0 | ≤ 5 ms | 42 / 72 % |
| optimizada-3 | 7,15 / 7,15 / 7,15 | 80 / 274 / **2.553** | 253 / 630 / **4.428** | ≤ 0,25 / ≤ 1 / ≤ 5 s | 0 / 1 / 0 | ≤ 5 ms | 37 / 68 % |

**De dónde sale la cola,** por los viajes de más de 2 s:
- **por el TTL de la oferta:** 11, 13 y 13 viajes (0,5 % de cada corrida), todos entre 13 y 19 s. Cada viaje se ofrece a 3 choferes; si los 3 ya tomaron otro viaje, la oferta queda pendiente hasta que vence a los 15 s y se ofrece de nuevo;
- **por el disco:** 6 en `optimizada-2` y 58 en `optimizada-3`, todos dentro de las pausas de la tabla anterior.

**Los pings a location, en la ventana de los viajes.** Los choferes de prueba cuentan lo que enviaron y lo que location les aceptó (204), del lado del cliente. location cuenta todos los `POST /ubicaciones` que aceptó, por `/metrics`; el fondo de k6 es la diferencia.

| Corrida | Choferes de prueba activos | Enviados / aceptados por location (por s) | location aceptó (por s) | Fondo de k6 aceptado (por s) | Fallidos |
|---|---|---|---|---|---|
| ingenua-1 | 50 de 50 | 25 / 25,1 | 142,5 | 117,3 | 0 |
| ingenua-2 | 50 de 50 | 25 / 22,5 | 116,8 | 94,3 | 0 |
| ingenua-3 | 50 de 50 | 25 / 22,4 | 114,4 | 92,1 | 0 |
| optimizada-1 | 50 de 50 | 25 / 25 | 275,1 | 250,1 | 0 |
| optimizada-2 | 50 de 50 | 25 / 25 | 275 | 250 | 0 |
| optimizada-3 | 50 de 50 | 25 / 25 | 259,2 | 234,2 | 0 |

- **En la optimizada,** location aceptó los 275 pings/s previstos: 250 del fondo y 25 de los choferes de prueba.
- **En la ingenua, location no llega:** acepta entre 114 y 143 pings/s en total. De los choferes de prueba, 22,4 a 25,1/s; el resto queda en vuelo al cerrar la ventana (la ingenua tarda unos 5 s por ping). Del fondo, 92 a 117/s: k6 omite entre 43.000 y 51.000 pings por corrida, como el 19/11. **Lo que se satura en la ingenua es location**, no dispatch (13 % de CPU).
- **En `optimizada-3`, el fondo da 234/s** porque la ventana de los viajes duró 317 s en vez de 295: los últimos viajes, atrasados por la pausa del disco, terminaron después de que k6 dejó de enviar. Los 75.000 pings de k6 de la medición se aceptaron todos.
- **Las ubicaciones de 6.6, en estas mismas corridas** ([`tablas.md`](mediciones/2026-11-24/tablas.md)): pings p95 de 5.814 ms en la ingenua y 8,7 ms en la optimizada; búsquedas p95 de 5.765 y 8,3 ms.

**Competencia y corrección.** Las 6 corridas dieron 0 en: ofertas a no aptos (por SSE y en la base), viajes de no aptos, viajes fuera de Córdoba, asignados sin flota y viajes activos al final.

| Corrida | Iteraciones | Ofertas recibidas | Aceptadas (200) | 409 esperados (`SOLICITUD_NO_DISPONIBLE`) | Errores al aceptar |
|---|---|---|---|---|---|
| optimizada-1 | 2.364 | 7.125 | 2.364 | 3.802 | 0 |
| optimizada-2 | 2.329 | 7.026 | 2.329 | 3.732 | 0 |
| optimizada-3 | 2.271 | 6.870 | 2.270 | 3.608 | 0 |

En `optimizada-3`, el viaje sin resolver venció la espera de 20 s en la pausa del disco; el pasajero consultó su estado y lo canceló.

#### Escenario B: estrés por escalones

Ventana estable de cada escalón (45 s). Cada celda es **corrida 1 / corrida 2 / corrida 3**. «Intentos/s» son los `POST /solicitudes` iniciados en la ventana; creados y asignados por segundo están en [`tablas.md`](mediciones/2026-11-24/tablas.md).

| Tasa (viajes/s) | Intentos/s | Asignados/s | `POST` p95 (ms) | Asignación p95, cliente (ms) | Omitidos por k6 (de los previstos en la etapa) | Sin resolver | CPU dispatch / Postgres / location (%) | Lag dispatch p99 | ¿Degradada? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 / 1,02 / 1 | 1 / 1,02 / 1 | 122 / 103 / 181 | 363 / 331 / 387 | 0 / 0 / 0 (de 60) | 0 / 0 / 0 | 8-12 · 6-8 · 59-62 | ≤ 2 ms | no / no / no |
| 2 | 2,02 / 2,02 / 2,02 | 2,02 / 2,02 / 2,02 | 141 / 214 / 196 | 433 / 362 / 394 | 0 / 0 / 0 (de 120) | 0 / 0 / 0 | 13-15 · 8-9 · 62-68 | ≤ 2 ms | no / no / no |
| 4 | 4,02 / 4,02 / 4 | 4,03 / 4,02 / 4 | 128 / 178 / 130 | 333 / 351 / 302 | 0 / 0 / 0 (de 240) | 0 / 0 / 0 | 24-31 · 10-12 · 59-63 | ≤ 2 ms | no / no / no |
| 8 | 8,02 / **5,96** / 8,02 | 8,02 / **5,04** / 8,02 | 164 / **13.883** / 144 | 378 / **9.226** / 355 | 0 / **93** / 0 (de 480) | 0 / **41** / 0 | 35-39 · 11-18 · 59-67 | ≤ 2 / ≤ 10 / ≤ 2 ms | no / **sí** / no |
| 16 | 13,31 / 11 / 12,89 | 10,67 / 8,09 / 10,76 | **18.113 / 9.280 / 8.074** | 561 / **8.871 / 8.986** | **122 / 320 / 140** (de 960) | **110 / 131 / 95** | 47-51 · 15-17 · 59-65 | ≤ 10 / ≤ 100 / ≤ 100 ms | **sí / sí / sí** |
| 32 | 19,31 / 20,36 / 20,64 | **0** / 8,58 / 8,87 | **5.421 / 3.927 / 3.868** | — / **10.514 / 10.420** | **764 / 670 / 646** (de 1.920) | **869 / 530 / 531** | 70-96 · 21-28 · 67-75 | ≤ 100 ms | **sí / sí / sí** |

- **Sin `NoDriversFound` ni errores** en ninguna ventana estable. Hubo 9 respuestas 503 de ubicación en el escalón de 16 viajes/s de `estres-1` (de 599 intentos).
- **Los pings a location,** en todos los escalones de las 3 corridas: **310 choferes de prueba activos, 154,8 a 155,9 pings/s enviados y aceptados**; location recibió y aceptó **404,8 a 406/s**, de los que 250 son del fondo. No cambian con la tasa de viajes.
- **La memoria (RSS):** dispatch sube de 129-133 MB en 1 viaje/s a 165-166 MB en 32; location queda entre 122 y 175 MB.
- **Las primeras etapas degradadas:** **16 viajes/s** en las corridas 1 y 3, y **8 viajes/s** en la 2. El escalón de 8 de la corrida 2 coincide con la pausa del disco de 06:25:19 a 06:26:23.
- **El techo de 19 a 21 intentos/s en 32 viajes/s lo pone k6, no el sistema:** cada escalón tiene `min(250, tasa × 8)` usuarios virtuales, así que con 32 viajes/s hay 250. Si cada iteración tarda más de unos 8 s (crear, esperar hasta 10 s y cancelar), por la ley de Little no alcanzan, y k6 omite el resto. Ese techo mide cuánto tarda un viaje, no cuántos acepta dispatch.
- **En 32 viajes/s de la corrida 1 no se asignó ninguno dentro de la ventana:** los 869 iniciados quedaron sin resolver en 10 s y se cancelaron.

**Corrección:** en las 3 corridas, 0 viajes activos al final, 0 ofertas y 0 viajes para los no aptos, 0 fuera de Córdoba y 0 asignados sin flota.

#### Conclusión de cada hipótesis

| # | Resultado | Por qué |
|---|---|---|
| HS1 | **Se cumple, salvo el p99 de una corrida** | Mediana de la optimizada: `POST` p95 **249 ms** (≤ 300), asignación p95 **581 ms** (≤ 1 s) y p99 **1.835 ms** (≤ 2 s). 0 errores en las 3 corridas. Por corrida, `optimizada-1` y `optimizada-2` cumplen todo; `optimizada-3` no cumple el p99 (4.428 ms) por los 58 viajes de la pausa del disco |
| HS2 | **Se cumple** | En las 3 corridas, el **100 %** de los intentos respondió 503 `UBICACION_NO_DISPONIBLE`, en **1.007 ms** de mediana (el timeout de 1 s). 9,93 intentos/s, **0 creados y 0 asignados**, ninguno activo: falla cerrado. Lo que se satura es location: acepta 114 a 143 pings/s de los 275 previstos |
| HS3 | **Se cumple** | 0 ofertas y 0 viajes a no aptos, 0 fuera de Córdoba y 0 asignados sin flota en las 9 corridas. Competencia: **entre 3.608 y 3.802 409 `SOLICITUD_NO_DISPONIBLE` por corrida**, ningún error al aceptar y cada viaje con una sola aceptación. **0 viajes activos al final en las 9 corridas.** La carrera de 6.3 también pasa con los datos nuevos |
| HS4 | **Se cumple** | Lag de dispatch en la ventana: p99 **≤ 5 ms** (cubeta) en la optimizada y **≤ 2 ms** en la ingenua, < 20 ms. CPU de dispatch: **42 %** de promedio en la optimizada y 13 % en la ingenua, < 60 % |
| HE1 | **Se cumple en 2 de 3 corridas** | Las corridas 1 y 3 sostienen 8 viajes/s, con `POST` p95 de 164 y 144 ms y asignación p95 de 378 y 355 ms. La corrida 2 se degrada en 8 viajes/s durante una pausa del disco, con la CPU de dispatch y de Postgres en 0-6 % |
| HE2 | **Se cumple el escalón, no del todo la causa** | La degradación empieza en **16 viajes/s** en las corridas 1 y 3 (y en 8 en la 2, por el disco), y en 32 se degradan las 3. **La causa en 16 viajes/s no es la CPU de dispatch** (47-51 %) ni location (59-65 %, pings estables): es la espera del commit en el disco mecánico, que agota el pool de 10 conexiones. Con commit asíncrono, 16 viajes/s pasa y la degradación empieza en 32, con dispatch al 98 % de CPU: ahí sí el límite es dispatch, como decía la hipótesis, aunque location también llega a su CPU |
| HE3 | **Se cumple en parte** | Antes de la primera etapa degradada, el lag p99 de dispatch es **≤ 2 ms** en las 3 corridas (< 50 ms). En las etapas degradadas sube a **≤ 10 ms y ≤ 100 ms**, y la CPU de dispatch llega a **93-96 %** en 32 viajes/s de las corridas 2 y 3. En 16 viajes/s la CPU promedio es de 47-51 %: la degradación empieza antes de que dispatch se quede sin CPU |

**Qué se puede concluir:**
- **La optimizada habilita la asignación bajo la carga de 6.6, y la ingenua no:** con la ingenua, todos los intentos fallan cerrado a 1 s y no se crea ningún viaje. Con la optimizada, el 95 % de los viajes se asigna en menos de 0,6 s.
- **En esta máquina, el primer límite de dispatch es el disco, y el segundo su CPU:** con el volumen de Postgres en el disco mecánico, sostiene unos 8 viajes/s y se degrada en 16. Sin esperar al disco, sostiene 16 y se satura en 32, con dispatch y location cerca del 100 % de su CPU. Para pasar de ahí harían falta más CPU o réplicas de dispatch (y de location), y un pool que acompañe a Postgres. **Antes de sacar un número de capacidad para el informe, el escenario B tendría que repetirse con Docker en un SSD.**
- **El p99 de la asignación lo marcan el TTL de la oferta y el disco,** no la búsqueda. Una oferta a un chofer ocupado espera 15 s. Bajarlo cambiaría el producto (el chofer tiene menos tiempo para aceptar), así que se informa como está.

**Limitaciones:**
- **Es local:** k6, los servicios y Postgres comparten la máquina, y **el volumen de Postgres está en un disco mecánico**. Los commits de dispatch esperan ese disco (p95 de 1,2 s sin carga), y eso pone pausas de 15 a 25 s en corridas al azar. Con Docker en un SSD habría que repetir el escenario B.
- **Los choferes de prueba no tienen tiempo de reacción:** aceptan enseguida. Se mide el sistema, no a las personas.
- **Resolución:**
  - en el estrés, el tiempo hasta la asignación en el cliente tiene una resolución de ±100 ms, por la consulta cada 100 ms;
  - el servidor y el lag se informan por cubeta, así que «≤ 100 ms» significa entre 50 y 100 ms.
- **El techo de intentos del estrés lo pone k6** (250 usuarios virtuales en 32 viajes/s), no el sistema.
- **Tres corridas por escenario** alcanzan para ver la tendencia, pero no para dar intervalos de confianza.
