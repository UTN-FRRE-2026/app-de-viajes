# Observabilidad: métricas, logs y Grafana Cloud

Los tres servicios publican `GET /metrics` (formato de Prometheus) y escriben un log JSON por pedido. **Grafana Alloy**, en un perfil opcional del Compose, lee las dos cosas y las manda a Grafana Cloud, donde están los tres dashboards de [`observabilidad/dashboards/`](../observabilidad/dashboards) (PLAN 5.6).

```
identity :3001 ─┐  GET /metrics (Bearer METRICAS_TOKEN), por la red interna
location :3004 ─┼──────────────▶ Alloy ──remote_write──▶ Grafana Cloud Prometheus
dispatch :3005 ─┘                  │
   stdout (pino, JSON) ──socket de Docker──▶ Alloy ──push──▶ Grafana Cloud Loki
```

| Archivo | Qué es |
|---|---|
| `observabilidad/alloy/config.alloy` | La configuración de Alloy. No tiene ninguna credencial: todo llega por variables de entorno |
| `observabilidad/dashboards/salud.json` | (a) Salud de los tres servicios |
| `observabilidad/dashboards/despacho.json` | (b) Despacho |
| `observabilidad/dashboards/tarea-pesada.json` | (c) Tarea pesada (6.6) |
| `docker-compose.yml`, servicio `alloy` | `grafana/alloy:v1.21.3`, solo con `--profile obs` |
| `observabilidad/alloy/Dockerfile`, `docker-compose.coolify.yml` | La misma imagen con `config.alloy` adentro, para Coolify ([En Coolify](#en-coolify)) |

## Qué se mide y por qué

Todas las series llevan `servicio` (la pone `platform`) y, al pasar por Alloy, `entorno` (`desarrollo` o `carga`), `job="app-viajes"` e `instance`.

| Métrica | Dónde | Para qué |
|---|---|---|
| `event_loop_lag_seconds` (histograma) | los tres | El lag del event loop por ventana: un temporizador cada 100 ms anota cuánto se atrasó. Es la medida de 6.6: con location aparte, la carga de pings no tiene que frenar a dispatch |
| `event_loop_lag_ms{quantile}`, `event_loop_lag_max_ms`, `event_loop_lag_mean_ms` | los tres | El mismo lag, desde el arranque (`monitorEventLoopDelay`). El máximo no baja hasta reiniciar el proceso |
| `process_resident_memory_bytes`, `nodejs_heap_used_bytes` | los tres | Memoria: una pérdida se ve como una rampa que no baja |
| `http_request_duration_seconds{metodo, ruta, estado}` | los tres | Tasa, latencia (p50, p95, p99) y errores por ruta. La ruta es el patrón (`/solicitudes/:id`), nunca la URL: con ids, cada pedido crearía una serie. De acá salen los 5xx, los 4xx y los 429 |
| `dispatch_solicitudes_total{resultado}` | dispatch | Solicitudes creadas: `con_ofertas` o `sin_choferes` |
| `dispatch_asignaciones_total` | dispatch | Asignaciones confirmadas (una por solicitud) |
| `dispatch_ofertas_vencidas_total` | dispatch | Ofertas que el barrido marcó vencidas |
| `dispatch_busquedas_sin_aptos_total{motivo}` | dispatch | Búsquedas sin ningún chofer apto: `sin_candidatos`, `filtrados` o `tope_agotado` |
| `dispatch_tiempo_hasta_asignacion_seconds` (histograma) | dispatch | Desde que el pasajero pide (antes de buscar candidatos) hasta el COMMIT de la aceptación. Incluye lo que tarda el chofer en aceptar |
| `dispatch_tarifas_cache_total{resultado}` | dispatch | Caché de tarifas en Redis: `hit`, `miss` o `error` (Redis falló y se leyó Postgres) |
| `dispatch_zonas_cache_total{resultado}` | dispatch | Lo mismo para el caché de zonas (polígonos y flotas de cada zona, para el filtro de candidatos) |
| `location_pings_total{de, estrategia, resultado}` | location | **Pings por segundo**: cada `POST /ubicaciones` (`de="chofer"`) y `POST /ubicaciones/pasajero` (`de="pasajero"`), por resultado: `aceptado` (2xx), `limitado` (429), `rechazado` (otro 4xx) o `error` (5xx). Con `estrategia`, se comparan corridas de la ingenua y la optimizada |
| `location_estrategia{estrategia}` | location | Con qué estrategia corre (siempre 1) |
| `location_historial_en_cola`, `location_historial_pendientes`, `location_historial_ocupacion`, `location_historial_max_cola`, `location_historial_descartados_total` | location (optimizada) | La cola del historial en Redis: si crece sin bajar, Postgres no da abasto; si la ocupación llega a 1, se descartan pings del historial |
| `location_posiciones_publicadas_total{de, resultado}` | location | La posición en vivo: `publicada`, `atrasada`, `vencida` o `error` |

El detalle de cada una está en [docs/location.md](location.md#get-metrics) y [docs/arquitectura.md](arquitectura.md#observabilidad).

`location_pings_total` se cuenta con un middleware que va **antes** de la autenticación y del límite de tasa, al terminar de enviar la respuesta: cuenta también los 401 y los 429. Un ping cuyo cliente cortó antes de la respuesta no se cuenta (igual que `http_request_duration_seconds`). Test: `services/location/tests/seguridad/metricas-pings.test.ts`.

**Logs.** pino escribe una línea JSON por pedido (`packages/platform/src/log-pedidos.ts`): `requestId`, `metodo`, `ruta`, `estado`, `duracionMs`, usuario, rol e IP; 5xx en `error`, 4xx en `warn`. Alloy toma solo los contenedores `identity`, `location` y `dispatch` (de cualquier proyecto de Compose) y les pone las etiquetas `servicio`, `proyecto`, `contenedor` y `level` (el nivel de pino con su nombre: `info`, `warn`, `error`). El resto de los campos queda en la línea y se filtra en la consulta, sin crear una serie por pedido:

```logql
{servicio="dispatch", level="error"}
{servicio="location"} | json | estado = 429
{proyecto="app-viajes"} | json | requestId = "<el requestId que devolvió el error>"
```

## Activar el perfil

1. Completá en el `.env` las cinco variables `GRAFANA_CLOUD_*` (ver [Credenciales](#credenciales-en-grafana-cloud)). Están vacías y comentadas en `.env.example`.
2. Levantá el sistema con el perfil, o solo Alloy si el resto ya está corriendo:
   ```bash
   docker compose --profile obs up -d          # todo, con Alloy
   docker compose --profile obs up -d alloy    # solo Alloy
   ```
3. Comprobá que lee y envía:
   - `http://localhost:12345`: la interfaz de Alloy. Cada componente tiene que estar `healthy`; en `prometheus.scrape.servicios`, los tres destinos `up`. Se publica solo en `127.0.0.1`.
   - `docker compose logs alloy`: un `Failed to send batch` es un problema con la URL, el usuario o el token.
   - En Grafana Cloud, Explore: `up{job="app-viajes"}` da 1 por servicio, y `{proyecto="app-viajes"}` en Loki trae los logs.

**Sin credenciales el sistema levanta igual.** El perfil `obs` no se activa solo (`docker compose up` no crea Alloy) y nada depende de él: ni un `depends_on` ni un chequeo de `/ready`. Si se activa con las variables vacías, Alloy arranca igual y avisa en su log que no puede enviar (`unsupported protocol scheme ""`); los servicios no se enteran. Lo pide la secuencia de PLAN 2.4 y la defensa sin internet.

Variables que lee Alloy (las arma el Compose; ninguna es obligatoria para el resto del sistema):

| Variable | Por defecto | Qué es |
|---|---|---|
| `GRAFANA_CLOUD_PROM_URL`, `GRAFANA_CLOUD_PROM_USUARIO` | vacías | URL de envío y usuario de Prometheus |
| `GRAFANA_CLOUD_LOKI_URL`, `GRAFANA_CLOUD_LOKI_USUARIO` | vacías | URL de envío y usuario de Loki |
| `GRAFANA_CLOUD_TOKEN` | vacía | Token de la Access Policy, el mismo para los dos |
| `OBS_METRICAS_TOKEN` | `METRICAS_TOKEN` | Bearer de `/metrics` |
| `OBS_IDENTITY`, `OBS_LOCATION`, `OBS_DISPATCH` | `identity:3001`, `location:3004`, `dispatch:3005` | A quién lee, por la red interna |
| `OBS_ENTORNO` | `desarrollo` | Etiqueta `entorno` de las métricas |
| `OBS_INTERVALO` | `15s` | Cada cuánto lee `/metrics` |

**Por qué los logs van por el socket de Docker.** `loki.source.docker` los pide a la API de Docker, así que funciona igual en Docker Desktop (Windows, macOS) y en Linux. Leer los archivos `*-json.log` de `/var/lib/docker/containers` solo sirve en Linux: en Docker Desktop esos archivos están dentro de la máquina virtual. El costo: el socket da acceso amplio al daemon, y el `:ro` del montaje no lo limita (solo impide borrar el archivo). Por eso Alloy va en un perfil aparte, no publica nada fuera del host y no lo necesita ningún otro contenedor.

## Credenciales en Grafana Cloud

Con una cuenta gratuita alcanza. Los nombres de los menús pueden cambiar; lo que hay que conseguir son cinco valores.

1. Entrá a [grafana.com](https://grafana.com), creá la cuenta y un **stack** (por ejemplo, `appviajes`), en la región más cercana que ofrezca.
2. En el portal de la cuenta (**My Account**), en el stack, abrí **Prometheus → Details** (o *Send Metrics*):
   - **Remote Write Endpoint** → `GRAFANA_CLOUD_PROM_URL` (termina en `/api/prom/push`);
   - **Username / Instance ID** (un número) → `GRAFANA_CLOUD_PROM_USUARIO`.
3. En el mismo stack, **Loki → Details** (o *Send Logs*):
   - **URL** → `GRAFANA_CLOUD_LOKI_URL`, **con** `/loki/api/v1/push` al final si no lo trae;
   - **User** (otro número) → `GRAFANA_CLOUD_LOKI_USUARIO`.
4. **Security → Access Policies → Create access policy**: realm el stack, scopes `metrics:write` y `logs:write` (nada de lectura ni de administración). En la política, **Add token** y copiá el valor (`glc_...`): se muestra una sola vez. → `GRAFANA_CLOUD_TOKEN`.
5. Pegá los cinco en el `.env` y `docker compose --profile obs up -d alloy`. Si Alloy ya estaba corriendo, el mismo comando lo recrea con los valores nuevos.

El token solo puede escribir: si se filtra, nadie lee los datos con él. Igual, **nunca se versiona** (`.env` está en `.gitignore`) y se revoca desde la misma Access Policy. Para la cátedra no hace falta compartir nada: alcanza con los JSON de los dashboards y las capturas en `docs/evidencias/`.

**Volumen.** Cada servicio publica del orden de un par de cientos de series (157 en dispatch y 104 en location en la captura del estrés del 24/11, `docs/mediciones/2026-11-24-pings-cada-10s/estres-3/metrics/`), cada 15 s: lejos del límite del plan gratuito. Si hiciera falta bajar el uso, se sube `OBS_INTERVALO`.

## Importar los dashboards

1. En Grafana Cloud: **Dashboards → New → Import**.
2. **Upload dashboard JSON file** con uno de `observabilidad/dashboards/*.json`, y **Import**.
3. Arriba del dashboard, en **Prometheus**, elegí la fuente de datos del stack (`grafanacloud-<stack>-prom`); por defecto toma la predeterminada. En **Entorno**, `desarrollo` o `carga`.

Las consultas usan la fuente de datos como variable (`${DS_PROMETHEUS}`, de tipo *datasource*), así que el mismo JSON se importa en cualquier stack sin editarlo. Cada dashboard tiene un `uid` fijo (`viajes-salud`, `viajes-despacho`, `viajes-tarea-pesada`): importarlo de nuevo lo reemplaza.

| Dashboard | Paneles |
|---|---|
| **Salud de los servicios** | Arriba (`up`), % de 5xx y 429 en el rango, pedidos por segundo; lag del event loop p50 y p99 por ventana, promedio y máximo desde el arranque; RSS y heap; pedidos por segundo y latencia p50, p95 y p99 por ruta; 5xx, 4xx (sin 429) y 429 por ruta. Variable **Servicio** para ver uno solo. Las sondas (`/health`, `/ready`, `/metrics`) se excluyen de los paneles de tráfico y latencia |
| **Despacho** | Solicitudes por resultado, asignaciones, ofertas vencidas y búsquedas sin aptos; aceptaciones 200 contra 409 (la carrera de 6.3); tiempo hasta la asignación p50, p95 y promedio; caché de tarifas (y la tasa de HIT en el rango), caché de zonas; latencia de `POST /solicitudes` |
| **Tarea pesada (6.6)** | Estrategia; pings por segundo por resultado; latencia de `POST /ubicaciones`; cola del historial, pendientes, ocupación y descartados (optimizada); lag del event loop de location frente a dispatch; latencia de la búsqueda de candidatos y de la solicitud; memoria; publicaciones de la posición en vivo |

Los percentiles salen de los buckets de cada histograma, así que son aproximados: el lag va de 1 ms a 2 s, la duración HTTP de 5 ms a 10 s y el tiempo hasta la asignación de 50 ms a 60 s.

## En Coolify

En el entorno publicado ([despliegue.md](despliegue.md#coolify)) Alloy no es un perfil: es un servicio más de `docker-compose.coolify.yml`, siempre presente. Cambia respecto del perfil `obs`:

- **La configuración va adentro de la imagen** (`observabilidad/alloy/Dockerfile`, la misma `config.alloy`): Coolify no tiene los archivos del repo en el servidor para montarlos.
- **Sin puertos ni dominio.** La interfaz de Alloy escucha solo dentro del contenedor; la usa el healthcheck (`/-/ready`).
- **`entorno="produccion"`** en las métricas (`OBS_ENTORNO`). Los dashboards lo ofrecen solo en la variable **Entorno**.
- **Solo los logs de este recurso.** El servidor es compartido y el socket de Docker ve los contenedores de todas las apps. Alloy se queda con los del proyecto de Compose del recurso: Coolify usa su UUID como nombre de proyecto y se lo pasa a cada contenedor en `COOLIFY_RESOURCE_UUID`. Si hiciera falta fijarlo a mano, `OBS_PROYECTO` en las variables del recurso. En Loki, la etiqueta `proyecto` es ese UUID.
- **Las credenciales**, en *Environment Variables* del recurso. `node deploy/env-coolify.mjs` las suma a `deploy/.env.coolify` si están completas en `deploy/.env.produccion`. Sin ellas, Alloy arranca y no envía nada; los servicios no se enteran.

Para activarlo: completar las cinco `GRAFANA_CLOUD_*` ([Credenciales](#credenciales-en-grafana-cloud)) en `deploy/.env.produccion`, correr `node deploy/env-coolify.mjs`, pegar `deploy/.env.coolify` en Coolify (*Environment Variables → Developer view*) y **Redeploy**. Para comprobar: en los logs de `alloy` en Coolify, ningún `Failed to send batch`; en Grafana Cloud, Explore, `up{job="app-viajes", entorno="produccion"}` da 1 por servicio y `{servicio="dispatch"}` en Loki trae los logs.
## Durante una corrida de k6

Las mediciones corren en el **entorno de carga** (`carga/compose.yml`, proyecto `viajes-carga`), que no comparte red con el de desarrollo. Para verlas en Grafana, se conecta Alloy a la red de carga y se le cambia a quién lee:

```powershell
# 1. La red de carga tiene que existir: medir.ps1 levanta esto mismo al empezar (no recrea nada).
$env:ESTRATEGIA = 'optimizada'    # compose.yml de carga la exige
docker compose -p viajes-carga -f carga/compose.yml --env-file carga/.secretos/carga.env up -d --wait postgres redis jwks

# 2. Alloy, apuntando a los contenedores de carga, con el token de /metrics de carga.
$env:OBS_ENTORNO = 'carga'
$env:OBS_METRICAS_TOKEN = (Select-String -Path carga/.secretos/carga.env -Pattern '^CARGA_TOKEN_SERVICIO=(.+)$').Matches[0].Groups[1].Value
$env:OBS_LOCATION = 'viajes-carga-location-1:3004'
$env:OBS_DISPATCH = 'viajes-carga-dispatch-1:3005'
docker compose --profile obs up -d alloy
docker network connect viajes-carga_default app-viajes-alloy-1

# 3. La corrida, como siempre (carga/README.md). En Grafana, Entorno = carga.
powershell -NoProfile -ExecutionPolicy Bypass -File carga/medir.ps1 -Estrategia optimizada -Corrida 1 -Solicitudes

# 4. Al terminar: desconectar ANTES de bajar el entorno de carga (si no, Docker no puede borrar la red),
#    y volver Alloy al de desarrollo.
docker network disconnect viajes-carga_default app-viajes-alloy-1
Remove-Item Env:OBS_*
docker compose --profile obs up -d alloy
```

- `medir.ps1` recrea los contenedores de location y dispatch, pero no la red: Alloy sigue conectado y los vuelve a encontrar por nombre.
- En carga no hay identity: su destino aparece caído (`up` = 0). Y los servicios de carga corren con `LOG_PEDIDOS=no`, así que en Loki solo se ven el arranque, el apagado y los avisos.
- Alloy suma un `GET /metrics` cada 15 s por servicio: poco al lado de 250 pings/s, pero las mediciones de [docs/mediciones.md](mediciones.md) se tomaron sin él. Aparece en `http_request_duration_seconds{ruta="/metrics"}`, y los dashboards lo excluyen. Si una corrida con Alloy entra al informe, anotalo.
- Alloy no es la fuente de los números del informe: `medir.ps1` sigue tomando sus fotos de `/metrics` al empezar y al terminar cada ventana. Los dashboards son la vista en vivo y la evidencia en capturas.

**Qué mirar, por script:**

| Script | Dashboard | Qué mirar |
|---|---|---|
| `medir.ps1` (`ubicaciones.js`, 500 choferes) | Tarea pesada | Pings aceptados ≈ 250/s y nada en `limitado` ni `error`; la latencia de `POST /ubicaciones`; en la optimizada, que la cola del historial suba y baje (no que crezca sin parar) y descartados en 0; el lag de location |
| `medir.ps1 -Solicitudes` | Tarea pesada y Despacho | El lag p99 de **dispatch** frente al de location (la evidencia de 6.6: dispatch no se entera de los pings); la latencia de la búsqueda de candidatos y de `POST /solicitudes`; solicitudes `con_ofertas`, asignaciones y tiempo hasta la asignación |
| `estres.ps1` (rampa) | Salud y Despacho | En qué escalón aparecen los 5xx o los 503, cuándo se dispara el p99 de `POST /solicitudes` y el lag; la memoria |
| `carrera.ps1` (50 aceptaciones, 6.3) | Despacho | Aceptaciones: exactamente un 200 y el resto 409; una sola asignación |

## Seguridad

- **`/metrics` no se publica por nginx**: `infra/web/default.conf` responde 404 a `/api/*/metrics`, igual que a `/interno/*` y `/ready` ([docs/web.md](web.md)). Alloy lo lee por la red interna del Compose. En desarrollo los puertos 3001, 3004 y 3005 se publican en el host, pero `/metrics` sigue pidiendo el token.
- **Un secreto para cada cosa**: `/metrics` pide `Authorization: Bearer <METRICAS_TOKEN>`; el token de servicio no lo abre ([docs/seguridad.md](seguridad.md)). Alloy lo manda con `bearer_token`. Si no coincide, el destino aparece caído (401).
- Las credenciales de Grafana Cloud están solo en el `.env`; `config.alloy` no tiene ninguna.
- La interfaz de Alloy (`:12345`) se publica solo en `127.0.0.1`.

## Cómo se probó

Sin una cuenta de Grafana Cloud a mano, el envío se probó contra reemplazos locales, con la misma `config.alloy` y la misma imagen:
- `alloy validate` y `alloy fmt` sobre la configuración, y `docker compose config` con y sin `--profile obs`.
- Alloy leyendo un location real (con `location_pings_total`) y una captura real de dispatch servida como `/metrics`, con el token: los destinos `up`; uno inexistente, `down`.
- `remote_write` a un Prometheus con `--web.enable-remote-write-receiver`: 0 muestras fallidas, y **cada consulta de los tres dashboards** evaluada contra él devolvió series (salvo las que no podían tener datos: 5xx y 429 sin errores, la cola del historial sin la optimizada).
- Los logs, a un receptor que responde 204: llegaron con el usuario de Loki por basic auth, y con las etiquetas `servicio`, `proyecto`, `contenedor` y `level`.

Falta comprobarlo contra Grafana Cloud de verdad, con credenciales.
