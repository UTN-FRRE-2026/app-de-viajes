# Tablas de la tanda del 24/11/2026

Salida de `node carga/resumir.mjs docs/mediciones/2026-11-24`, sin editar. `ingenua-2` está en [`../2026-11-24-descartadas/`](../2026-11-24-descartadas/): ver docs/mediciones.md.

#### Conteos por corrida

«Medición» = los 5 min sin el calentamiento. «Corrida completa» = calentamiento + medición (330 s).

| Corrida | Pings enviados: medición / corrida completa | Aceptados (204): medición / corrida completa | Omitidos por k6 (corrida completa) | Con error (corrida completa) | Guardados en historial (corrida completa) | Descartados (cola llena) | Escritura pendiente al terminar k6 (s) |
|---|---|---|---|---|---|---|---|
| ingenua-1 | 37014 / 42272 | 36534 / 41792 | 40229 | 0 | 43415 | 0 | 0.0 |
| ingenua-3 | 37957 / 42740 | 37640 / 42423 | 39761 | 0 | 43929 | 0 | 0.0 |
| ingenua-4 | 37140 / 42164 | 37140 / 42164 | 40337 | 0 | 43364 | 0 | 0.0 |
| optimizada-1 | 74977 / 82478 | 74977 / 82478 | 23 | 0 | 84228 | 0 | 0.1 |
| optimizada-2 | 75000 / 82501 | 75000 / 82501 | 0 | 0 | 84201 | 0 | 0.0 |
| optimizada-3 | 75000 / 82501 | 75000 / 82501 | 0 | 0 | 84251 | 0 | 0.0 |

#### Latencia y recursos por corrida

Latencias, pings/s, errores y CPU: solo la medición. Lag y RSS: desde que arranca location (no se pueden separar).

| Corrida | Pings p50 / p95 / p99 (ms) | Búsquedas p50 / p95 / p99 (ms) | /health p50 / p95 / p99 (ms) | Pings/s | Errores (%) | Lag p99 / máx (ms) | RSS location (MB) | CPU location prom. / máx (%) | CPU Postgres prom. (%) | CPU Redis prom. (%) | Muestras de CPU |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ingenua-1 | 4056.3 / 4564.3 / 4929.6 | 4016.8 / 4505.6 / 4878.3 | 0.9 / 7.7 / 17.9 | 121.8 | 0.00 | 12.6 / 91.3 | 139 | 47 / 75 | 23 | 3 | 45 |
| ingenua-3 | 3627.0 / 6310.3 / 9664.2 | 3774.9 / 6657.0 / 10618.1 | 0.9 / 9.3 / 20.2 | 125.5 | 0.00 | 22.5 / 125.0 | 131 | 47 / 85 | 23 | 3 | 45 |
| ingenua-4 | 4098.5 / 4702.4 / 5233.1 | 4063.7 / 4652.9 / 5167.4 | 0.8 / 6.2 / 12.8 | 123.8 | 0.00 | 15.0 / 122.1 | 147 | 45 / 62 | 22 | 3 | 43 |
| optimizada-1 | 1.9 / 23.2 / 116.4 | 2.8 / 31.4 / 112.1 | 0.9 / 3.4 / 78.0 | 249.9 | 0.00 | 8.9 / 335.0 | 112 | 58 / 99 | 13 | 11 | 45 |
| optimizada-2 | 1.6 / 5.8 / 38.4 | 2.4 / 6.5 / 48.8 | 0.8 / 3.2 / 7.3 | 250.0 | 0.00 | 3.7 / 99.8 | 127 | 49 / 78 | 16 | 10 | 45 |
| optimizada-3 | 1.9 / 6.8 / 38.1 | 2.8 / 7.1 / 37.2 | 0.8 / 2.3 / 6.3 | 250.0 | 0.00 | 4.6 / 94.5 | 117 | 55 / 85 | 18 | 10 | 43 |

#### Mediana de las corridas por estrategia (3 por estrategia)

| Estrategia | Corridas | Pings p95 (ms) | Pings p99 (ms) | Búsquedas p95 (ms) | Búsquedas p99 (ms) | /health p95 (ms) | Pings/s | Lag p99 (ms) | Lag máx (ms) | RSS (MB) | CPU location (%) | CPU Postgres (%) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ingenua | 3 | 4702.4 | 5233.1 | 4652.9 | 5167.4 | 7.7 | 123.8 | 15.0 | 122.1 | 139 | 47 | 23 |
| optimizada | 3 | 6.8 | 38.4 | 7.1 | 48.8 | 3.2 | 250.0 | 4.6 | 99.8 | 117 | 55 | 16 |

### Viajes en paralelo bajo la carga de 6.6 (escenario A)

Solo la ventana de medición. Cliente: percentiles exactos. Servidor: por cubeta (el borde superior de la cubeta del percentil).

| Corrida | Viajes/s | Asignados/s | `POST /solicitudes` cliente p50 / p95 / p99 (ms) | Hasta la asignación, cliente p50 / p95 / p99 (ms) | Hasta la asignación, servidor p50 / p95 / p99 | 503 ubicación | Sin choferes | Sin resolver | Errores | Lag dispatch p99 | RSS dispatch / location al final (MB) | CPU dispatch prom. / máx (%) | Pings: fondo / choferes de prueba (por s) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ingenua-1 | 9.93 | 0 | 1007 / 1010 / 1022 | — / — / — | — / — / — | 2920 | 0 | 0 | 0 | 2 ms | 122 / 146 | 13 / 36 | 122 / 3.6 |
| ingenua-3 | 9.93 | 0 | 1007 / 1011 / 1021 | — / — / — | — / — / — | 2920 | 0 | 0 | 0 | 2 ms | 122 / 150 | 12 / 34 | 125 / 3.6 |
| ingenua-4 | 9.93 | 0 | 1007 / 1010 / 1019 | — / — / — | — / — / — | 2920 | 0 | 0 | 0 | 2 ms | 122 / 147 | 11 / 40 | 124 / 3.6 |
| optimizada-1 | 5 | 4.98 | 103 / 3095 / 9259 | 337 / 5749 / 17521 | 500 ms / 10000 ms / 30000 ms | 4 | 0 | 4 | 0 | 10 ms | 137 / 112 | 35 / 81 | 250 / 5 |
| optimizada-2 | 7.85 | 7.85 | 86 / 212 / 335 | 280 / 478 / 944 | 250 ms / 500 ms / 1000 ms | 0 | 0 | 0 | 0 | 5 ms | 139 / 127 | 37 / 66 | 250 / 5 |
| optimizada-3 | 7.38 | 7.38 | 88 / 243 / 482 | 291 / 566 / 8546 | 250 ms / 500 ms / 10000 ms | 0 | 0 | 0 | 0 | 10 ms | 122 / 117 | 39 / 60 | 250 / 4.9 |

#### Competencia y corrección (escenario A)

| Corrida | Iteraciones | Ofertas recibidas | Aceptadas (200) | 409 esperados | Errores al aceptar | Ofertas a no aptos (SSE / base) | Viajes activos al final | Viajes de no aptos | Fuera de Córdoba | Asignados sin flota |
|---|---|---|---|---|---|---|---|---|---|---|
| ingenua-1 | 2920 | 0 | 0 | 0 | 0 | 0 / 0 | 0 | 0 | 0 | 0 |
| ingenua-3 | 2920 | 0 | 0 | 0 | 0 | 0 / 0 | 0 | 0 | 0 | 0 |
| ingenua-4 | 2920 | 0 | 0 | 0 | 0 | 0 / 0 | 0 | 0 | 0 | 0 |
| optimizada-1 | 1558 | 4743 | 1552 | SOLICITUD_NO_DISPONIBLE 2311 | 0 | 0 / 0 | 0 | 0 | 0 | 0 |
| optimizada-2 | 2356 | 7110 | 2356 | SOLICITUD_NO_DISPONIBLE 3740 | 0 | 0 / 0 | 0 | 0 | 0 | 0 |
| optimizada-3 | 2323 | 7020 | 2323 | SOLICITUD_NO_DISPONIBLE 3730 | 0 | 0 / 0 | 0 | 0 | 0 | 0 |

#### Mediana de las corridas por estrategia (escenario A)

| Estrategia | Corridas | Viajes/s | `POST /solicitudes` p50 / p95 / p99 (ms) | Hasta la asignación p50 / p95 / p99 (ms) | 503 ubicación (% de los intentos) | Lag dispatch p99 (ms, cubeta) | CPU dispatch prom. (%) | RSS dispatch / location (MB) |
|---|---|---|---|---|---|---|---|---|
| ingenua | 3 | 9.93 | 1007 / 1010 / 1021 | — / — / — | 100.0 | 2 | 12 | 122 / 147 |
| optimizada | 3 | 7.38 | 88 / 243 / 482 | 291 / 566 / 8546 | 0.0 | 10 | 37 | 137 / 117 |

### Estrés por escalones (escenario B)

Ventana estable de cada escalón (sin la transición). Degradada si incumple cualquier criterio de docs/mediciones.md.

#### estres-1: primera etapa degradada: 16 viajes/s (crear_p95, asignacion_p95, omitidos)

| Tasa (viajes/s) | Previstos (etapa / ventana) | Iniciados (ventana) | Omitidos por k6 (etapa) | Viajes/s | Asignados | Sin choferes | Sin resolver | 503 ubicación | Errores | Crear p50 / p95 / p99 (ms) | Asignación p50 / p95 / p99 (ms) | Asignación servidor p95 | Lag dispatch p99 | RSS dispatch / location (MB) | CPU dispatch / Postgres / location (%) | Pings a location: total / choferes de prueba (por s) | ¿Degradada? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 60 / 45 | 45 | 0 | 1 | 45 | 0 | 0 | 0 | 0 | 66 / 120 / 285 | 269 / 336 / 456 | 500 ms | 2 ms | 134 / 122 | 17 / 6 / 59 | 277.6 / 27.6 | no |
| 2 | 120 / 90 | 90 | 0 | 2 | 90 | 0 | 0 | 0 | 0 | 72 / 169 / 381 | 278 / 383 / 998 | 500 ms | 2 ms | 135 / 127 | 17 / 12 / 61 | 277.5 / 27.6 | no |
| 4 | 240 / 180 | 180 | 0 | 4 | 180 | 0 | 0 | 0 | 0 | 65 / 151 / 299 | 265 / 377 / 520 | 500 ms | 2 ms | 138 / 127 | 26 / 11 / 65 | 277.6 / 27.6 | no |
| 8 | 480 / 360 | 359 | 0 | 7.98 | 359 | 0 | 0 | 0 | 0 | 69 / 141 / 258 | 263 / 371 / 535 | 500 ms | 5 ms | 145 / 127 | 45 / 17 / 58 | 277.8 / 27.6 | no |
| 16 | 960 / 720 | 705 | 15 | 15.67 | 693 | 0 | 2 | 0 | 0 | 186 / 1028 / 2057 | 435 / 2334 / 6408 | 2000 ms | 100 ms | 149 / 127 | 84 / 28 / 61 | 277.6 / 27.6 | sí |
| 32 | 1920 / 1440 | 778 | 893 | 17.29 | 0 | 0 | 778 | 0 | 0 | 3972 / 5157 / 10357 | 0 / 0 / 0 | 60000 ms | 100 ms | 165 / 150 | 78 / 24 / 61 | 277.5 / 27.6 | sí |

Corrección: viajes activos al final 15, ofertas a no aptos 0, viajes de no aptos 0, fuera de Córdoba 0, asignados sin flota 0. k6 terminó con 99 (99: se incumplió algún criterio de degradación).

#### estres-2: primera etapa degradada: 16 viajes/s (crear_p95, asignacion_p95, omitidos)

| Tasa (viajes/s) | Previstos (etapa / ventana) | Iniciados (ventana) | Omitidos por k6 (etapa) | Viajes/s | Asignados | Sin choferes | Sin resolver | 503 ubicación | Errores | Crear p50 / p95 / p99 (ms) | Asignación p50 / p95 / p99 (ms) | Asignación servidor p95 | Lag dispatch p99 | RSS dispatch / location (MB) | CPU dispatch / Postgres / location (%) | Pings a location: total / choferes de prueba (por s) | ¿Degradada? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 60 / 45 | 45 | 0 | 1 | 45 | 0 | 0 | 0 | 0 | 74 / 167 / 317 | 276 / 378 / 546 | 500 ms | 2 ms | 141 / 123 | 18 / 7 / 55 | 277.6 / 27.6 | no |
| 2 | 120 / 90 | 91 | 0 | 2.02 | 91 | 0 | 0 | 0 | 0 | 76 / 184 / 266 | 273 / 377 / 477 | 500 ms | 2 ms | 131 / 123 | 17 / 11 / 55 | 277.6 / 27.6 | no |
| 4 | 240 / 180 | 181 | 0 | 4.02 | 181 | 0 | 0 | 0 | 0 | 73 / 144 / 301 | 270 / 377 / 497 | 500 ms | 2 ms | 138 / 124 | 26 / 11 / 65 | 277.8 / 27.6 | no |
| 8 | 480 / 360 | 359 | 2 | 7.98 | 359 | 0 | 0 | 0 | 0 | 79 / 417 / 1333 | 278 / 811 / 1828 | 1000 ms | 5 ms | 146 / 126 | 48 / 18 / 61 | 277.6 / 27.6 | no |
| 16 | 960 / 720 | 694 | 26 | 15.42 | 691 | 0 | 3 | 0 | 0 | 177 / 1515 / 2696 | 439 / 3079 / 4158 | 5000 ms | 100 ms | 151 / 127 | 77 / 25 / 52 | 277.5 / 27.6 | sí |
| 32 | 1920 / 1440 | 862 | 714 | 19.16 | 70 | 0 | 792 | 0 | 0 | 4201 / 4705 / 4997 | 10213 / 10821 / 11028 | 15000 ms | 100 ms | 166 / 127 | 90 / 30 / 69 | 277.6 / 27.6 | sí |

Corrección: viajes activos al final 0, ofertas a no aptos 0, viajes de no aptos 0, fuera de Córdoba 0, asignados sin flota 0. k6 terminó con 99 (99: se incumplió algún criterio de degradación).

#### estres-3: primera etapa degradada: 8 viajes/s (crear_p95, asignacion_p95, omitidos, sin_resolver)

| Tasa (viajes/s) | Previstos (etapa / ventana) | Iniciados (ventana) | Omitidos por k6 (etapa) | Viajes/s | Asignados | Sin choferes | Sin resolver | 503 ubicación | Errores | Crear p50 / p95 / p99 (ms) | Asignación p50 / p95 / p99 (ms) | Asignación servidor p95 | Lag dispatch p99 | RSS dispatch / location (MB) | CPU dispatch / Postgres / location (%) | Pings a location: total / choferes de prueba (por s) | ¿Degradada? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 60 / 45 | 46 | 0 | 1.02 | 46 | 0 | 0 | 0 | 0 | 66 / 110 / 125 | 184 / 335 / 434 | 500 ms | 2 ms | 133 / 123 | 11 / 8 / 63 | 277.6 / 27.6 | no |
| 2 | 120 / 90 | 91 | 0 | 2.02 | 91 | 0 | 0 | 0 | 0 | 72 / 152 / 324 | 270 / 376 / 530 | 500 ms | 2 ms | 134 / 124 | 14 / 13 / 64 | 277.6 / 27.6 | no |
| 4 | 240 / 180 | 181 | 0 | 4.02 | 181 | 0 | 0 | 0 | 0 | 85 / 208 / 314 | 285 / 454 / 610 | 500 ms | 2 ms | 139 / 126 | 31 / 13 / 62 | 277.6 / 27.6 | no |
| 8 | 480 / 360 | 240 | 134 | 5.33 | 206 | 0 | 34 | 0 | 0 | 3523 / 9307 / 10543 | 7125 / 9662 / 10603 | 10000 ms | 100 ms | 148 / 144 | 19 / 11 / 49 | 277.6 / 27.6 | sí |
| 16 | 960 / 720 | 721 | 8 | 16.02 | 721 | 0 | 0 | 0 | 0 | 88 / 249 / 458 | 273 / 530 / 939 | 500 ms | 100 ms | 150 / 143 | 75 / 29 / 59 | 278.1 / 28 | no |
| 32 | 1920 / 1440 | 840 | 710 | 18.67 | 146 | 0 | 694 | 0 | 0 | 4597 / 6093 / 6408 | 9904 / 10778 / 11184 | 15000 ms | 100 ms | 166 / 144 | 82 / 27 / 67 | 278.7 / 28.6 | sí |

Corrección: viajes activos al final 0, ofertas a no aptos 0, viajes de no aptos 0, fuera de Córdoba 0, asignados sin flota 0. k6 terminó con 99 (99: se incumplió algún criterio de degradación).

