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
| `solicitudes.js` | Viajes en paralelo de punta a punta (Node, por el SSE) durante la medición: ver [Viajes en paralelo](#viajes-en-paralelo-escenario-a) |
| `lib/choferes.mjs`, `lib/metricas.mjs` | Los choferes de prueba (SSE, aceptar, posición) y la lectura de `/metrics` por ventana, compartidos por los dos escenarios |
| `estres.js`, `estres.ps1`, `estres-choferes.mjs` | La rampa de estrés por escalones: ver [Estrés por escalones](#estrés-por-escalones-escenario-b) |
| `carrera.js`, `carrera.ps1` | La carrera de la asignación única (6.3) con k6: ver [Carrera de la asignación única](#carrera-de-la-asignación-única-63) |
| `limpiar.ps1` | Vacía `pings` y las claves `carga:location:*`. **Se niega a correr** si algo no es del entorno de carga |
| `flotas.sql` | La flota y las zonas de carga, con los 500 choferes de k6 y el de `solicitudes.js` aptos: sin esto, el filtro de flotas y zonas de dispatch los descarta. Lo aplican `carrera.ps1` y `medir.ps1 -Solicitudes` después de `limpiar.ps1` |
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

## Viajes en paralelo (escenario A)

Con `-Solicitudes`, `medir.ps1` también levanta **dispatch de carga** y corre `carga/solicitudes.js` en paralelo con k6, **durante la fase de medición** de las ubicaciones. Las hipótesis y los umbrales están en [docs/mediciones.md](../docs/mediciones.md#solicitudes-de-viaje-bajo-carga-y-estrés-66-k6).

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File carga/medir.ps1 -Estrategia optimizada -Corrida 1 -Solicitudes
```

- **dispatch de carga:** el mismo Postgres, con su base `dispatch_carga` (`medir.ps1` la crea y la migra), el mismo Redis y el mismo JWKS.
  - Busca candidatos en el location de carga, con el **filtro real de flotas y zonas** (`flotas.sql`).
  - Publica en `127.0.0.1:43005` (`$env:CARGA_DISPATCH_PUERTO` para cambiarlo).
  - `limpiar.ps1` también vacía sus tablas y sus claves `dispatch:*`.
- **Por qué Node y no k6:** pasajeros y choferes se enteran de sus eventos por SSE (`GET /eventos`), y k6 no lee streams. El script corre en un contenedor `node:22-alpine` dentro de la red de carga, sin dependencias.
- **Los participantes** (`tokens-viajes.json`, de `preparar.mjs`):
  - **los pasajeros:** 20, distintos (`-Pasajeros`);
  - **los choferes de prueba:** 40 aptos (`-ChoferesAptos`) y 10 no aptos (4 inactivos, 3 no disponibles y 3 de una flota que no opera en Córdoba).
  - **Dónde:** todos en Córdoba, lejos de los 500 choferes de k6 (Buenos Aires).
  - **Su posición:** cada chofer de prueba la informa cada 10 s. Son **pings extra**, que se cuentan aparte del fondo de 250 pings/s.
- **Un pasajero,** en lazo cerrado:
  1. crea el viaje;
  2. espera `TripAssigned` o `NoDriversFound` en su SSE, hasta 20 s;
  3. lo deja asignado 1 s;
  4. cancela, y confirma por `GET` que ya no está activo;
  5. espera 1 s.

  Si la espera vence, consulta el estado y **cancela si sigue activo antes de volver a pedir**. Si no se puede liberar, ese pasajero se detiene.
- **Un chofer:**
  - acepta enseguida la primera oferta mientras está libre;
  - las que le llegan mientras acepta otra, las prueba si pierde esa (409);
  - las que le llegan con un viaje tomado, las ignora y vencen solas.

  Cada viaje se ofrece a 3 choferes: los que pierden reciben 409 `SOLICITUD_NO_DISPONIBLE`, que se cuenta como **esperado**.
- **Idempotency-Key:** una nueva por operación. Ante un error de red, un 5xx o un 409 «clave en curso», se reintenta **con la misma clave**, hasta 3 veces. El 503 `UBICACION_NO_DISPONIBLE` no se reintenta: es la falla cerrada que se mide.
- **Qué deja,** en la carpeta de la corrida:
  - `solicitudes.json`: una fila por iteración y el resumen, sin tokens;
  - fotos de `/metrics` de dispatch y de location al empezar y al terminar la ventana;
  - `correccion.txt`: la consulta y su resultado en `dispatch_carga`. Al final no queda nada activo, nada para los no aptos, todo en la zona Córdoba, y todo lo asignado tiene su flota;
  - todo, también dentro de `conteos.json`.
- **El resumen** incluye:
  - los viajes por segundo;
  - `POST /solicitudes` y el tiempo hasta la asignación, en el cliente (p50, p95 y p99 exactos) y en el servidor (por cubeta);
  - los 409 esperados, los sin resolver, los 503 de ubicación y los errores, **por separado**;
  - el lag de dispatch y de location en la ventana (`event_loop_lag_seconds`) y su memoria;
  - los pings de los choferes de prueba.

## Estrés por escalones (escenario B)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File carga/estres.ps1 -Corrida 1
```

- **Los pasajeros** los hace k6 (`estres.js`), en modelo abierto, con un escalón por tasa: 1, 2, 4, 8, 16 y 32 viajes/s, 60 s cada uno, después de 30 s de calentamiento.
  - **Cada usuario virtual es un pasajero distinto.**
  - **El fondo de 6.6** (`ubicaciones.js`) corre en **otro k6**, así sus usuarios virtuales no se mezclan con los de los pasajeros.
  - **Una iteración:**
    1. crea el viaje;
    2. consulta su estado cada 100 ms hasta `ASIGNADO` o `SIN_CHOFERES` (hasta 10 s);
    3. cancela si sigue activo, y lo confirma.
- **Los choferes de prueba** (300 aptos y 10 no aptos) y las fotos de `/metrics` los hace `estres-choferes.mjs` (Node).
- **La ventana estable:** los primeros 15 s de cada escalón son la transición, y se mide en los 45 s siguientes. Por escalón quedan los viajes previstos, los iniciados y los omitidos por k6.
- **Los criterios de degradación** son umbrales de k6 que **no cortan la corrida**. Si se incumplen, k6 termina con 99, y `estres.ps1` lo registra como resultado.
- **Qué deja,** en `docs/mediciones/<fecha>/estres-<corrida>/`:
  - `etapas-k6.json`: el cliente, por escalón;
  - `etapas-servidor.json`: dispatch y location en cada ventana estable (latencia por ruta, tiempo hasta la asignación, lag, memoria y pings);
  - `metrics/`: las fotos;
  - `choferes.json`, `fondo/`, `docker-stats.csv` y `correccion.txt`.
- **Prueba corta:** `-CalentamientoS 10 -SegundosEtapa 20 -SegundosTransicion 5 -Etapas '1,4'`.

## Las mediciones del informe y cuánto tardan

| Escenario | Comando | Por corrida | Corridas |
|---|---|---|---|
| A: viajes bajo la carga de 6.6 | `medir.ps1 -Estrategia {ingenua,optimizada} -Corrida N -Solicitudes`, alternadas | unos 8 min | 6 |
| B: estrés por escalones | `estres.ps1 -Corrida N` | unos 10 min | 3 |

Las tablas salen con `node carga/resumir.mjs docs/mediciones/<fecha>`.

## Carrera de la asignación única (6.3)

`carrera.ps1` reproduce con k6, contra el sistema en contenedores, el test `services/dispatch/tests/concurrencia/asignacion-unica.test.ts`: **50 choferes aceptan a la vez la misma solicitud**.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File carga/carrera.ps1 -Corrida 1
```

1. **Entorno:** baja la imagen de k6 si falta, levanta Postgres, Redis, JWKS, location (optimizada) y dispatch, migra, limpia y **espera a que los servicios estén listos**. Dispatch arranca con 50 ofertas por solicitud y 120 s de vigencia (`CARGA_OFERTAS_SIMULTANEAS` y `CARGA_OFERTA_TTL_SEGUNDOS`; sin esas variables, 3 y 15 s).
2. **Preparación:**
   - los primeros 50 choferes de `tokens.json` informan su posición en Córdoba, a 1 m uno del otro;
   - el pasajero de `tokens-solicitudes.json` pide el viaje y dispatch le ofrece a los 50;
   - las 50 ofertas **se leen de `dispatch_carga`** (como el test, que las lee del repositorio) y quedan en `ofertas.json` con una `Idempotency-Key` cada una.
3. **La carrera** (`carrera.js`): un solo `http.batch` con las 50 aceptaciones en paralelo, cada una con el token de su chofer y su clave. 200 y 409 son estados esperados. Los checks exigen **exactamente 1×200 y 49×409 `SOLICITUD_NO_DISPONIBLE`**, y k6 termina con error si alguno falla.
4. **PostgreSQL, antes de cancelar:**
   - la solicitud en `ASIGNADO` con el ganador;
   - **una sola fila en `driver_active_assignment`**, y es la del ganador;
   - las ofertas en `ACEPTADA: 1, CANCELADA: 49`;
   - un solo `TripAssigned`.
5. **Liberar:** el pasajero cancela, la solicitud queda `CANCELADO_PASAJERO` y `driver_active_assignment` queda vacía.

**Evidencia**, en `docs/mediciones/<fecha>/carrera-<corrida>/`, sin tokens ni contraseñas:
- `ofertas.json` (ofertas, choferes y claves) y `respuestas.json` (estado, código y duración de cada aceptación, y el ganador);
- `postgres.txt` (cada consulta con su salida), `k6.txt`, `resumen-k6.json` y `dispatch-log.txt`;
- `resultado.json` (el veredicto, con `ok`).

La corrida termina con error si algo no coincide.

**Límite:** el test fuerza la superposición con una demora dentro de la transacción, y acá no hay demora. Que las 50 salieron juntas se ve en la suma de las duraciones contra el tiempo total del lote, pero la garantía no depende de eso: el resultado tiene que ser el mismo.

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
