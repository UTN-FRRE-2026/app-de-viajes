#### Conteos por corrida

«Medición» = los 5 min sin el calentamiento. «Corrida completa» = calentamiento + medición (330 s).

| Corrida | Pings enviados: medición / corrida completa | Aceptados (204): medición / corrida completa | Omitidos por k6 (corrida completa) | Con error (corrida completa) | Guardados en historial (corrida completa) | Descartados (cola llena) | Escritura pendiente al terminar k6 (s) |
|---|---|---|---|---|---|---|---|
| ingenua-1 | 35049 / 39307 | 35049 / 39307 | 43194 | 0 | 47460 | 0 | 0.0 |
| ingenua-2 | 27997 / 32236 | 27653 / 31892 | 50265 | 0 | 39686 | 0 | 0.0 |
| ingenua-3 | 27376 / 31753 | 26926 / 31303 | 50748 | 0 | 38999 | 0 | 0.0 |
| optimizada-1 | 75000 / 82501 | 75000 / 82501 | 0 | 0 | 90683 | 0 | 0.0 |
| optimizada-2 | 75000 / 82491 | 75000 / 82491 | 10 | 0 | 90696 | 0 | 0.0 |
| optimizada-3 | 75000 / 82501 | 75000 / 82501 | 0 | 0 | 91239 | 0 | 0.0 |

#### Latencia y recursos por corrida

Latencias, pings/s, errores y CPU: solo la medición. Lag y RSS: desde que arranca location (no se pueden separar).

| Corrida | Pings p50 / p95 / p99 (ms) | Búsquedas p50 / p95 / p99 (ms) | /health p50 / p95 / p99 (ms) | Pings/s | Errores (%) | Lag p99 / máx (ms) | RSS location (MB) | CPU location prom. / máx (%) | CPU Postgres prom. (%) | CPU Redis prom. (%) | Muestras de CPU |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ingenua-1 | 4271.0 / 5089.1 / 5410.0 | 4278.2 / 5064.7 / 5370.1 | 1.1 / 13.6 / 73.3 | 116.8 | 0.00 | 31.6 / 111.5 | 152 | 55 / 92 | 26 | 3 | 43 |
| ingenua-2 | 4975.4 / 5999.2 / 29664.5 | 4938.2 / 5981.9 / 29702.0 | 1.1 / 6.6 / 71.2 | 92.2 | 0.00 | 25.1 / 94.1 | 181 | 44 / 69 | 21 | 3 | 43 |
| ingenua-3 | 4950.0 / 5814.2 / 22183.6 | 4909.6 / 5765.4 / 23467.7 | 0.9 / 32.3 / 37.8 | 89.8 | 0.00 | 12.3 / 116.3 | 184 | 44 / 72 | 22 | 3 | 43 |
| optimizada-1 | 1.9 / 8.7 / 48.1 | 2.8 / 8.3 / 33.3 | 0.9 / 2.1 / 5.4 | 250.0 | 0.00 | 6.4 / 105.5 | 124 | 60 / 87 | 19 | 12 | 43 |
| optimizada-2 | 2.0 / 9.2 / 51.5 | 2.8 / 9.6 / 34.3 | 0.7 / 20.3 / 25.6 | 250.0 | 0.00 | 6.5 / 189.2 | 109 | 57 / 83 | 18 | 11 | 43 |
| optimizada-3 | 1.4 / 4.6 / 38.1 | 2.2 / 5.4 / 23.6 | 0.7 / 1.8 / 10.0 | 250.0 | 0.00 | 3.0 / 123.6 | 120 | 48 / 70 | 15 | 10 | 43 |

#### Mediana de las corridas por estrategia (3 por estrategia)

| Estrategia | Corridas | Pings p95 (ms) | Pings p99 (ms) | Búsquedas p95 (ms) | Búsquedas p99 (ms) | /health p95 (ms) | Pings/s | Lag p99 (ms) | Lag máx (ms) | RSS (MB) | CPU location (%) | CPU Postgres (%) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ingenua | 3 | 5814.2 | 22183.6 | 5765.4 | 23467.7 | 13.6 | 92.2 | 25.1 | 111.5 | 181 | 44 | 22 |
| optimizada | 3 | 8.7 | 48.1 | 8.3 | 33.3 | 2.1 | 250.0 | 6.4 | 123.6 | 120 | 57 | 18 |

### Viajes en paralelo bajo la carga de 6.6 (escenario A)

Solo la ventana de medición. Cliente: percentiles exactos. Servidor: por cubeta (el borde superior de la cubeta del percentil).

Intentos: cada `POST /solicitudes`. Creados: los que respondieron 201. Asignados: los que llegaron a `TripAssigned`.

| Corrida | Intentos/s | Creados/s | Asignados/s | `POST /solicitudes` cliente p50 / p95 / p99 (ms) | Hasta la asignación, cliente p50 / p95 / p99 (ms) | Hasta la asignación, servidor p50 / p95 / p99 | 503 ubicación | Sin choferes | Sin resolver | Errores | Lag dispatch p99 | RSS dispatch / location al final (MB) | CPU dispatch prom. / máx (%) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ingenua-1 | 9.93 | 0 | 0 | 1008 / 1012 / 1027 | — / — / — | — / — / — | 2920 | 0 | 0 | 0 | 2 ms | 123 / 151 | 13 / 40 |
| ingenua-2 | 9.93 | 0 | 0 | 1007 / 1012 / 1026 | — / — / — | — / — / — | 2920 | 0 | 0 | 0 | 2 ms | 122 / 171 | 14 / 40 |
| ingenua-3 | 9.93 | 0 | 0 | 1007 / 1011 / 1022 | — / — / — | — / — / — | 2920 | 0 | 0 | 0 | 2 ms | 123 / 173 | 12 / 37 |
| optimizada-1 | 8.01 | 8.01 | 8.01 | 87 / 232 / 437 | 285 / 515 / 1118 | 250 ms / 500 ms / 1000 ms | 0 | 0 | 0 | 0 | 5 ms | 139 / 123 | 46 / 81 |
| optimizada-2 | 7.86 | 7.86 | 7.86 | 87 / 249 / 530 | 277 / 581 / 1835 | 250 ms / 500 ms / 1000 ms | 0 | 0 | 0 | 0 | 5 ms | 138 / 126 | 42 / 72 |
| optimizada-3 | 7.15 | 7.15 | 7.15 | 80 / 274 / 2553 | 253 / 630 / 4428 | 250 ms / 1000 ms / 5000 ms | 0 | 0 | 1 | 0 | 5 ms | 125 / 120 | 37 / 68 |

#### Pings a location en la ventana de los viajes (escenario A)

Choferes de prueba: lo que enviaron y lo que location les aceptó (204), del lado del cliente. Location: todos los `POST /ubicaciones` que aceptó en la ventana, por `/metrics`; el fondo de k6 es la diferencia.

| Corrida | Choferes de prueba (activos en la ventana / total) | Cadencia | Choferes de prueba: enviados / aceptados (por s) | Location aceptó (por s) | Fondo de k6 aceptado (por s) | Fallidos de los choferes de prueba |
|---|---|---|---|---|---|---|
| ingenua-1 | 50 / 50 | 2 s | 25 / 25.1 | 142.5 | 117.3 | 0 |
| ingenua-2 | 50 / 50 | 2 s | 25 / 22.5 | 116.8 | 94.3 | 0 |
| ingenua-3 | 50 / 50 | 2 s | 25 / 22.4 | 114.4 | 92.1 | 0 |
| optimizada-1 | 50 / 50 | 2 s | 25 / 25 | 275.1 | 250.1 | 0 |
| optimizada-2 | 50 / 50 | 2 s | 25 / 25 | 275 | 250 | 0 |
| optimizada-3 | 50 / 50 | 2 s | 25 / 25 | 259.2 | 234.2 | 0 |

#### Competencia y corrección (escenario A)

| Corrida | Iteraciones | Ofertas recibidas | Aceptadas (200) | 409 esperados | Errores al aceptar | Ofertas a no aptos (SSE / base) | Viajes activos al final | Viajes de no aptos | Fuera de Córdoba | Asignados sin flota |
|---|---|---|---|---|---|---|---|---|---|---|
| ingenua-1 | 2920 | 0 | 0 | 0 | 0 | 0 / 0 | 0 | 0 | 0 | 0 |
| ingenua-2 | 2920 | 0 | 0 | 0 | 0 | 0 / 0 | 0 | 0 | 0 | 0 |
| ingenua-3 | 2920 | 0 | 0 | 0 | 0 | 0 / 0 | 0 | 0 | 0 | 0 |
| optimizada-1 | 2364 | 7125 | 2364 | SOLICITUD_NO_DISPONIBLE 3802 | 0 | 0 / 0 | 0 | 0 | 0 | 0 |
| optimizada-2 | 2329 | 7026 | 2329 | SOLICITUD_NO_DISPONIBLE 3732 | 0 | 0 / 0 | 0 | 0 | 0 | 0 |
| optimizada-3 | 2271 | 6870 | 2270 | SOLICITUD_NO_DISPONIBLE 3608 | 0 | 0 / 0 | 0 | 0 | 0 | 0 |

#### Mediana de las corridas por estrategia (escenario A)

| Estrategia | Corridas | Intentos/s | Creados/s | Asignados/s | `POST /solicitudes` p50 / p95 / p99 (ms) | Hasta la asignación p50 / p95 / p99 (ms) | 503 ubicación (% de los intentos) | Lag dispatch p99 (ms, cubeta) | CPU dispatch prom. (%) | RSS dispatch / location (MB) |
|---|---|---|---|---|---|---|---|---|---|---|
| ingenua | 3 | 9.93 | 0.00 | 0.00 | 1007 / 1012 / 1026 | — / — / — | 100.0 | 2 | 13 | 123 / 171 |
| optimizada | 3 | 7.86 | 7.86 | 7.86 | 87 / 249 / 530 | 277 / 581 / 1835 | 0.0 | 5 | 42 | 138 / 123 |

### Estrés por escalones (escenario B)

Ventana estable de cada escalón (sin la transición). Degradada si incumple cualquier criterio de docs/mediciones.md.

#### estres-1: primera etapa degradada: 16 viajes/s (crear_p95, errores, omitidos, sin_resolver)

| Tasa (viajes/s) | Previstos (etapa / ventana) | Iniciados (ventana) | Omitidos por k6 (etapa) | Intentos / creados / asignados (por s) | Asignados | Sin choferes | Sin resolver | 503 ubicación | Errores | Crear p50 / p95 / p99 (ms) | Asignación p50 / p95 / p99 (ms) | Asignación servidor p95 | Lag dispatch p99 | RSS dispatch / location (MB) | CPU dispatch / Postgres / location (%) | Location: pings recibidos / aceptados / del fondo aceptados (por s) | Choferes de prueba: activos, enviados / aceptados (por s) | ¿Degradada? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 60 / 45 | 45 | 0 | 1 / 1.00 / 1.00 | 45 | 0 | 0 | 0 | 0 | 61 / 122 / 237 | 234 / 363 / 405 | 500 ms | 2 ms | 129 / 124 | 12 / 6 / 59 | 404.8 / 404.8 / 250 | 310, 154.8 / 154.8 | no |
| 2 | 120 / 90 | 91 | 0 | 2.02 / 2.02 / 2.02 | 91 | 0 | 0 | 0 | 0 | 71 / 141 / 203 | 264 / 433 / 509 | 500 ms | 1 ms | 131 / 125 | 13 / 9 / 68 | 404.8 / 404.8 / 250 | 310, 154.8 / 154.8 | no |
| 4 | 240 / 180 | 181 | 0 | 4.02 / 4.03 / 4.03 | 181 | 0 | 0 | 0 | 0 | 71 / 128 / 230 | 269 / 333 / 447 | 500 ms | 2 ms | 138 / 126 | 29 / 10 / 59 | 405.4 / 405.4 / 250.4 | 310, 154.8 / 155 | no |
| 8 | 480 / 360 | 361 | 0 | 8.02 / 8.02 / 8.02 | 361 | 0 | 0 | 0 | 0 | 75 / 164 / 285 | 272 / 378 / 498 | 500 ms | 2 ms | 145 / 126 | 39 / 16 / 59 | 404.8 / 404.8 / 250 | 310, 154.8 / 154.8 | no |
| 16 | 960 / 720 | 599 | 122 | 13.31 / 13.11 / 10.67 | 480 | 0 | 110 | 9 | 0 | 114 / 18113 / 20612 | 291 / 561 / 8014 | 500 ms | 10 ms | 149 / 144 | 47 / 17 / 60 | 404.8 / 404.8 / 250 | 310, 154.8 / 154.8 | sí |
| 32 | 1920 / 1440 | 869 | 764 | 19.31 / 19.32 / 0.00 | 0 | 0 | 869 | 0 | 0 | 3607 / 5421 / 5619 | 0 / 0 / 0 | 15000 ms | 100 ms | 166 / 175 | 70 / 21 / 67 | 406 / 406 / 250.1 | 310, 154.8 / 155.9 | sí |

Corrección: viajes activos al final 0, ofertas a no aptos 0, viajes de no aptos 0, fuera de Córdoba 0, asignados sin flota 0. k6 terminó con 99 (99: se incumplió algún criterio de degradación).

#### estres-2: primera etapa degradada: 8 viajes/s (crear_p95, asignacion_p95, omitidos, sin_resolver)

| Tasa (viajes/s) | Previstos (etapa / ventana) | Iniciados (ventana) | Omitidos por k6 (etapa) | Intentos / creados / asignados (por s) | Asignados | Sin choferes | Sin resolver | 503 ubicación | Errores | Crear p50 / p95 / p99 (ms) | Asignación p50 / p95 / p99 (ms) | Asignación servidor p95 | Lag dispatch p99 | RSS dispatch / location (MB) | CPU dispatch / Postgres / location (%) | Location: pings recibidos / aceptados / del fondo aceptados (por s) | Choferes de prueba: activos, enviados / aceptados (por s) | ¿Degradada? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 60 / 45 | 46 | 0 | 1.02 / 1.02 / 1.02 | 46 | 0 | 0 | 0 | 0 | 67 / 103 / 115 | 256 / 331 / 419 | 500 ms | 2 ms | 133 / 122 | 8 / 8 / 62 | 404.9 / 404.9 / 249.9 | 310, 155 / 154.9 | no |
| 2 | 120 / 90 | 91 | 0 | 2.02 / 2.02 / 2.02 | 91 | 0 | 0 | 0 | 0 | 72 / 214 / 292 | 276 / 362 / 427 | 500 ms | 2 ms | 134 / 124 | 15 / 8 / 64 | 405 / 405 / 250 | 310, 154.9 / 155 | no |
| 4 | 240 / 180 | 181 | 0 | 4.02 / 4.02 / 4.02 | 181 | 0 | 0 | 0 | 0 | 72 / 178 / 251 | 265 / 351 / 451 | 500 ms | 2 ms | 139 / 126 | 31 / 12 / 63 | 405 / 405 / 250 | 310, 154.9 / 155 | no |
| 8 | 480 / 360 | 268 | 93 | 5.96 / 5.95 / 5.04 | 227 | 0 | 41 | 0 | 0 | 345 / 13883 / 15851 | 311 / 9226 / 10520 | 10000 ms | 10 ms | 149 / 161 | 37 / 11 / 64 | 405 / 405 / 250 | 310, 154.9 / 155 | sí |
| 16 | 960 / 720 | 495 | 320 | 11 / 11.00 / 8.09 | 364 | 0 | 131 | 0 | 0 | 1864 / 9280 / 10008 | 3620 / 8871 / 10323 | 15000 ms | 100 ms | 157 / 163 | 51 / 17 / 59 | 405 / 405 / 250 | 310, 155 / 154.9 | sí |
| 32 | 1920 / 1440 | 916 | 670 | 20.36 / 20.36 / 8.58 | 386 | 0 | 530 | 0 | 0 | 3508 / 3927 / 4111 | 9288 / 10514 / 10713 | 10000 ms | 100 ms | 165 / 163 | 93 / 27 / 75 | 405 / 405 / 250.1 | 310, 154.9 / 155 | sí |

Corrección: viajes activos al final 0, ofertas a no aptos 0, viajes de no aptos 0, fuera de Córdoba 0, asignados sin flota 0. k6 terminó con 99 (99: se incumplió algún criterio de degradación).

#### estres-3: primera etapa degradada: 16 viajes/s (crear_p95, asignacion_p95, omitidos, sin_resolver)

| Tasa (viajes/s) | Previstos (etapa / ventana) | Iniciados (ventana) | Omitidos por k6 (etapa) | Intentos / creados / asignados (por s) | Asignados | Sin choferes | Sin resolver | 503 ubicación | Errores | Crear p50 / p95 / p99 (ms) | Asignación p50 / p95 / p99 (ms) | Asignación servidor p95 | Lag dispatch p99 | RSS dispatch / location (MB) | CPU dispatch / Postgres / location (%) | Location: pings recibidos / aceptados / del fondo aceptados (por s) | Choferes de prueba: activos, enviados / aceptados (por s) | ¿Degradada? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 60 / 45 | 45 | 0 | 1 / 1.00 / 1.00 | 45 | 0 | 0 | 0 | 0 | 70 / 181 / 293 | 266 / 387 / 493 | 500 ms | 2 ms | 133 / 125 | 10 / 6 / 62 | 404.9 / 404.9 / 250 | 310, 154.9 / 154.9 | no |
| 2 | 120 / 90 | 91 | 0 | 2.02 / 2.02 / 2.02 | 91 | 0 | 0 | 0 | 0 | 74 / 196 / 256 | 281 / 394 / 516 | 500 ms | 1 ms | 134 / 126 | 13 / 8 / 62 | 404.9 / 404.9 / 250 | 310, 154.9 / 154.9 | no |
| 4 | 240 / 180 | 180 | 0 | 4 / 4.00 / 4.00 | 180 | 0 | 0 | 0 | 0 | 63 / 130 / 228 | 255 / 302 / 363 | 250 ms | 2 ms | 138 / 125 | 24 / 11 / 63 | 404.9 / 404.9 / 250 | 310, 154.9 / 154.9 | no |
| 8 | 480 / 360 | 361 | 0 | 8.02 / 8.02 / 8.02 | 361 | 0 | 0 | 0 | 0 | 64 / 144 / 226 | 255 / 355 / 432 | 500 ms | 2 ms | 145 / 126 | 35 / 18 / 67 | 404.8 / 404.8 / 250 | 310, 154.9 / 154.9 | no |
| 16 | 960 / 720 | 580 | 140 | 12.89 / 12.87 / 10.76 | 485 | 0 | 95 | 0 | 0 | 1934 / 8074 / 8599 | 3260 / 8986 / 10369 | 15000 ms | 100 ms | 156 / 151 | 48 / 15 / 65 | 404.9 / 404.9 / 250 | 310, 154.8 / 154.8 | sí |
| 32 | 1920 / 1440 | 929 | 646 | 20.64 / 20.71 / 8.87 | 398 | 0 | 531 | 0 | 0 | 3458 / 3868 / 4058 | 9256 / 10420 / 10617 | 10000 ms | 100 ms | 165 / 151 | 96 / 28 / 75 | 406 / 406 / 250.6 | 310, 154.9 / 155.3 | sí |

Corrección: viajes activos al final 0, ofertas a no aptos 0, viajes de no aptos 0, fuera de Córdoba 0, asignados sin flota 0. k6 terminó con 99 (99: se incumplió algún criterio de degradación).

