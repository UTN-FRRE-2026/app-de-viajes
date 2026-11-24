#### Conteos por corrida

«Medición» = los 5 min sin el calentamiento. «Corrida completa» = calentamiento + medición (330 s).

| Corrida | Pings enviados: medición / corrida completa | Aceptados (204): medición / corrida completa | Omitidos por k6 (corrida completa) | Con error (corrida completa) | Guardados en historial (corrida completa) | Descartados (cola llena) | Escritura pendiente al terminar k6 (s) |
|---|---|---|---|---|---|---|---|

#### Latencia y recursos por corrida

Latencias, pings/s, errores y CPU: solo la medición. Lag y RSS: desde que arranca location (no se pueden separar).

| Corrida | Pings p50 / p95 / p99 (ms) | Búsquedas p50 / p95 / p99 (ms) | /health p50 / p95 / p99 (ms) | Pings/s | Errores (%) | Lag p99 / máx (ms) | RSS location (MB) | CPU location prom. / máx (%) | CPU Postgres prom. (%) | CPU Redis prom. (%) | Muestras de CPU |
|---|---|---|---|---|---|---|---|---|---|---|---|

#### Mediana de las corridas por estrategia (3 por estrategia)

| Estrategia | Corridas | Pings p95 (ms) | Pings p99 (ms) | Búsquedas p95 (ms) | Búsquedas p99 (ms) | /health p95 (ms) | Pings/s | Lag p99 (ms) | Lag máx (ms) | RSS (MB) | CPU location (%) | CPU Postgres (%) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

### Estrés por escalones (escenario B)

Ventana estable de cada escalón (sin la transición). Degradada si incumple cualquier criterio de docs/mediciones.md.

#### estres-1: primera etapa degradada: 32 viajes/s (crear_p95, omitidos, sin_resolver)

| Tasa (viajes/s) | Previstos (etapa / ventana) | Iniciados (ventana) | Omitidos por k6 (etapa) | Intentos / creados / asignados (por s) | Asignados | Sin choferes | Sin resolver | 503 ubicación | Errores | Crear p50 / p95 / p99 (ms) | Asignación p50 / p95 / p99 (ms) | Asignación servidor p95 | Lag dispatch p99 | RSS dispatch / location (MB) | CPU dispatch / Postgres / location (%) | Location: pings recibidos / aceptados / del fondo aceptados (por s) | Choferes de prueba: activos, enviados / aceptados (por s) | ¿Degradada? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 8 | 480 / 360 | 361 | 0 | 8.02 / 8.02 / 8.02 | 361 | 0 | 0 | 0 | 0 | 21 / 82 / 341 | 127 / 262 / 752 | 250 ms | 5 ms | 139 / 121 | 42 / 22 / 95 | 405.2 / 405.2 / 250.1 | 310, 155.1 / 155.2 | no |
| 16 | 960 / 720 | 721 | 0 | 16.02 / 16.02 / 16.02 | 721 | 0 | 0 | 0 | 0 | 43 / 179 / 282 | 171 / 415 / 531 | 500 ms | 100 ms | 147 / 122 | 83 / 37 / 100 | 405.2 / 405.2 / 250 | 310, 155.1 / 155.1 | no |
| 32 | 1920 / 1440 | 860 | 711 | 19.11 / 19.08 / 0.00 | 0 | 0 | 860 | 0 | 0 | 3858 / 4377 / 4551 | 0 / 0 / 0 | 15000 ms | 100 ms | 162 / 123 | 98 / 33 / 98 | 405.2 / 405.2 / 250 | 310, 155.1 / 155.1 | sí |

Corrección: viajes activos al final 0, ofertas a no aptos 0, viajes de no aptos 0, fuera de Córdoba 0, asignados sin flota 0. k6 terminó con 99 (99: se incumplió algún criterio de degradación).

