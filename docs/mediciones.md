# Informe de mediciones

Cubre la tarea pesada de 6.6 (location: recepción masiva de ubicaciones y búsqueda de candidatos). La condición de carrera principal (6.3) y el tiempo hasta la asignación se agregan cuando dispatch use location (PR de integración).

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
- **No mide dispatch** (para eso está la [prueba piloto](#prueba-piloto-una-solicitud-real-bajo-la-carga-de-ubicaciones) de abajo): falta la latencia de la solicitud de viaje y el tiempo hasta la asignación que pide 6.6. Se agregan cuando dispatch use location (PR de Iván).

## Prueba piloto: una solicitud real bajo la carga de ubicaciones

**22/11, una corrida corta** con `medir.ps1 -Estrategia optimizada -Medicion 60 -Calentamiento 10 -Solicitudes` (ver [carga/README.md](../carga/README.md#solicitud-real-prueba-piloto)). Es una **prueba piloto de latencia bajo carga**: muestra que el flujo real funciona de punta a punta mientras location absorbe 250 pings/s. No es todavía la medición del informe.

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
