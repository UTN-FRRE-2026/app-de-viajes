# Carga (k6) — entorno aislado

Mide las dos estrategias de location (6.6) con 500 choferes que mandan su ubicación cada 2 s. Todo corre en un **proyecto de Compose aparte**, `viajes-carga`, que **no comparte nada** con el entorno de desarrollo (`app-viajes`).

| | Entorno de desarrollo (`app-viajes`) | Entorno de carga (`viajes-carga`) |
|---|---|---|
| Postgres | volumen `pg_datos`, puerto 5434, base `location` | sin volumen con nombre, `127.0.0.1:45434`, base `location_carga`, usuario `carga` |
| Redis | puerto 6379, claves `location:*` | sin puerto publicado, claves `carga:location:*` |
| Tokens | firmados por identity (clave del `.env`) | firmados con una clave **solo de carga**; el JWKS lo sirve el contenedor `jwks` |
| Token de servicio | `LOCATION_TOKEN_SERVICIO` del `.env` | uno aleatorio en `carga/.secretos/carga.env` |
| location | puerto 3004 | `127.0.0.1:43004`, con **1 CPU y 512 MB** |

## Archivos

| Archivo | Para qué |
|---|---|
| `compose.yml` | El entorno de carga: Postgres, Redis, JWKS y location (y dispatch con `-Solicitudes`), con límites de CPU y memoria |
| `preparar.mjs` | Genera en `carga/.secretos/` (ignorado por git) la contraseña de Postgres, el token de servicio, la clave de carga y 500 tokens de chofer. Nunca imprime secretos |
| `ubicaciones.js` | Escenario de k6: 250 pings/s, 20 búsquedas/s y `/health` 2/s, en modelo abierto y deterministas |
| `solicitudes.js` | Solicitud real de punta a punta (Node, por el SSE) durante la medición: ver [Solicitud real](#solicitud-real-prueba-piloto) |
| `limpiar.ps1` | Vacía `pings` y las claves `carga:location:*`. **Se niega a correr** si algo no es del entorno de carga |
| `medir.ps1` | Una corrida completa: deja todo en `docs/mediciones/<fecha>/<estrategia>-<corrida>/` |
| `resumir.mjs` | Arma las tablas del informe con las corridas de una fecha |

## Cómo medir (PowerShell, desde la raíz del repo)

Requisitos: Docker Desktop en marcha y `npm ci` hecho. Los puertos 45434 y 43004 tienen que estar libres.

- **Puertos.** Por defecto quedan fuera del rango dinámico de Windows (49152-65535). Hyper-V y WSL reservan bloques de ese rango al arrancar, y Docker no puede publicar un puerto reservado («bind: An attempt was made to access a socket in a way forbidden by its access permissions»). Los reservados se ven con `netsh interface ipv4 show excludedportrange protocol=tcp`. Si 45434 o 43004 están ocupados, se cambian con `$env:CARGA_PG_PUERTO` y `$env:CARGA_LOCATION_PUERTO` antes de correr `medir.ps1`; `compose.yml` lee las mismas variables.
- **Migración.** Justo después de levantar Postgres, en Windows el puerto publicado puede tardar unos segundos en responder. `medir.ps1` reintenta la migración solo cuando Prisma da P1001 (hasta 10 veces, cada 2 s); cualquier otro error corta la corrida enseguida y muestra la salida sin la contraseña.

```powershell
node carga/preparar.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File carga/medir.ps1 -Estrategia ingenua -Corrida 1
powershell -NoProfile -ExecutionPolicy Bypass -File carga/medir.ps1 -Estrategia optimizada -Corrida 1
node carga/resumir.mjs docs/mediciones/2026-11-19
```

- **Prueba corta, para ver que todo funciona:** agregar `-Medicion 30 -Calentamiento 5`.
- **Duración:** cada corrida completa tarda unos 7 minutos (30 s de calentamiento, 5 min de medición, espera del historial y apagado). Las tres corridas por estrategia van alternadas: ingenua 1, optimizada 1, ingenua 2…

## Solicitud real (prueba piloto)

Con `-Solicitudes`, `medir.ps1` también levanta **dispatch de carga** y corre `carga/solicitudes.js` en paralelo con k6. Es una solicitud de viaje real, de punta a punta, **durante la fase de medición** de las ubicaciones:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File carga/medir.ps1 -Estrategia optimizada -Corrida 1 -Medicion 60 -Calentamiento 10 -Solicitudes
```

- **dispatch de carga:** el mismo Postgres, con su base `dispatch_carga` (`medir.ps1` la crea y la migra), el mismo Redis y el mismo JWKS. Busca candidatos en el location de carga y publica en `127.0.0.1:43005` (`$env:CARGA_DISPATCH_PUERTO` para cambiarlo). `limpiar.ps1` también vacía sus tablas y sus claves `dispatch:*`.
- **Por qué Node y no k6:** el chofer se entera de su oferta por SSE (`GET /eventos`, `OfferCreated`), y k6 no lee streams. El script corre en un contenedor `node:22-alpine` dentro de la red de carga, sin dependencias.
- **Aislado de la nube de k6:** un pasajero y un chofer dedicados (`tokens-solicitudes.json`, de `preparar.mjs`) en Córdoba, a más de 600 km de los 500 choferes simulados en Buenos Aires. Ninguno de esos es candidato, así la oferta le llega siempre al chofer del flujo. El chofer informa su posición cada 2 s para seguir vigente.
- **En la fase de medición:** el script espera a ver subir los pings de k6 en `/metrics` de location, después el calentamiento más 2 s, y deja de empezar iteraciones 5 s antes del final.
- **Una iteración:**
  1. el pasajero crea el viaje;
  2. el chofer recibe `OfferCreated` por su stream y acepta. Las ofertas que llegan **antes del 201** se guardan y se cruzan después por `solicitudId`;
  3. un `GET` confirma `ASIGNADO` con ese chofer;
  4. el pasajero cancela, lo que libera a los dos en la misma transacción, y un `GET` confirma `CANCELADO_PASAJERO` **antes de empezar la siguiente**.
- **Idempotency-Key:** una nueva por operación. Ante un error de red, un 5xx o un 409 «clave en curso», se reintenta **con la misma clave**, hasta 3 veces.
- **Qué deja** en la carpeta de la corrida:
  - `solicitudes.json`: una fila por iteración y el resumen, sin tokens;
  - `metrics-dispatch-antes.txt` y `metrics-dispatch.txt`: fotos de `/metrics` de dispatch al empezar y al terminar la ventana;
  - `solicitudes-log.txt` y `dispatch-log.txt`;
  - el resumen también dentro de `conteos.json`.
- **El resumen** incluye:
  - las iteraciones, las asignadas confirmadas por `GET` y las que no se asignaron, con su motivo;
  - el tiempo hasta la asignación **en el cliente** (del `POST /solicitudes` al 200 de la aceptación: p50, p95 y máximo);
  - en el **servidor**, el incremento del histograma `dispatch_tiempo_hasta_asignacion_seconds` entre las dos fotos, contrastado con las asignaciones confirmadas por `GET` (`coincide_con_get`), y su p50 y p95 por cubeta;
  - `SIN_CHOFERES`, las ofertas vencidas y el lag del event loop de dispatch.
- **Qué no mide:** ver las limitaciones en [docs/mediciones.md](../docs/mediciones.md#prueba-piloto-una-solicitud-real-bajo-la-carga-de-ubicaciones).

## Qué deja cada corrida

| Archivo | Contenido |
|---|---|
| `conteos.json` | Pings enviados, aceptados, omitidos por k6 y con error; filas guardadas en el historial; descartados; cuánto tardó en vaciarse la cola; commit |
| `resumen-k6.json` | Todas las métricas de k6, separadas por escenario y por fase (calentamiento o medición) |
| `k6.txt` | Lo que imprimió k6 |
| `metrics.txt` | `/metrics` de location al terminar k6 (con `Authorization: Bearer`): lag del event loop desde el arranque, memoria y cola del historial. Desde el 20/11 las series llevan `servicio="location"` y el lag se llama `event_loop_lag_ms`; `resumir.mjs` lee también el formato anterior |
| `docker-stats.csv` | CPU y memoria de location, Postgres y Redis, cada 5 s |
| `location-log.txt` | Últimas líneas del log de location, incluido el apagado ordenado |

Ningún archivo de resultados contiene tokens ni contraseñas.

## Apagar el entorno de carga

Desde la raíz del repo, en la misma terminal de PowerShell:

```powershell
$env:ESTRATEGIA = 'optimizada'
docker compose -p viajes-carga -f carga/compose.yml --env-file carga/.secretos/carga.env down -v
```

- `compose.yml` exige `ESTRATEGIA` incluso para `down`: sin ella, Compose corta con «required variable ESTRATEGIA is missing a value». `medir.ps1` la define solo dentro de su propio proceso, así que en una terminal nueva hay que definirla antes. Para apagar, el valor no importa.
- Ese `down -v` solo afecta al proyecto `viajes-carga`. Sus datos son descartables.
