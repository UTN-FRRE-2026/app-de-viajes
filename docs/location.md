# location

> **Estado: primer avance.** El servicio corre en su contenedor (puerto 3004). Recibe la ubicación de los choferes y responde a dispatch qué choferes están cerca de un origen, con la **versión ingenua** de 6.6 sobre PostgreSQL. dispatch todavía **no** lo llama: sigue con `buscador-fijo` hasta el PR de integración (ver [Contrato con dispatch](#contrato-con-dispatch-a-revisar-con-iván)).

## Quién es dueño de cada dato

| Dato | Dueño | Por qué |
|---|---|---|
| Posición vigente de cada chofer y su historial | **location** | Es la tarea pesada (500 choferes, un ping cada 2 s). En su propio proceso no le saca event loop a la asignación de viajes |
| Identidad del chofer (`choferId` = `sub` del JWT) | identity | location la toma del token y **nunca del body**: nadie puede informar la posición de otro |
| Habilitado, disponible, viaje activo, flota y zona habilitada | **dispatch** | Los filtra en su propia base. location no sabe nada de viajes ni de flotas |
| Qué choferes ya recibieron una oferta | dispatch | Es estado del viaje. location no necesita esa lista |

## Endpoints

Base local: `http://localhost:3001` es identity; location está en `http://localhost:3004`. Los errores usan el formato único `{error:{code,message,requestId}}`. Los esquemas están en `packages/contracts/src/location.ts`.

### `POST /ubicaciones`, el chofer informa su posición

Lleva `Authorization: Bearer <access token de identity>` y solo lo acepta el rol `chofer`.

```json
{ "lat": -34.6037, "lng": -58.3816 }
```

| Respuesta | Cuándo |
|---|---|
| `204`, sin cuerpo | Guardada, a nombre del chofer del token y con la hora del servidor |
| `400 VALIDACION` | Coordenadas fuera de rango, que no son números, que faltan, o una clave extra: `choferId`, `__proto__`… |
| `401 NO_AUTENTICADO` | Sin token, token inválido o vencido. El token de servicio tampoco sirve acá |
| `403 ROL_NO_PERMITIDO` | El token no es de un chofer |

Está pensado para k6: el camino del ping no hace ninguna lectura, solo valida, inserta y responde.

### `GET /interno/candidatos`, solo para dispatch

Lleva `X-Token-Servicio: <secreto compartido>`. Esta ruta **no se publica por nginx**.

`GET /interno/candidatos?lat=-34.6037&lng=-58.3816&limite=10&radioMetros=5000`

| Parámetro | Valor |
|---|---|
| `lat`, `lng` | Obligatorios, en rango. `0` es válido; un valor vacío no lo es |
| `limite` | 1 a 100. Por defecto, 10 |
| `radioMetros` | 1 a 50 000. Por defecto, 5000 |

```json
{ "candidatos": [ { "choferId": "uuid", "distanciaMetros": 412, "actualizadaEn": "2026-11-19T12:00:00.000Z" } ] }
```

- **Orden y criterio.** Van ordenados de menor a mayor distancia; a igual distancia, por `choferId`. Cuenta solo la **última** posición de cada chofer, y solo si tiene menos de `UBICACION_VIGENCIA_SEGUNDOS` (30 s por defecto). Un chofer que deja de reportar desaparece solo: no hay choferes fantasma.
- **Fin de la lista.** Si vienen **menos que `limite`**, no hay más choferes vigentes dentro del radio.
- **Lista vacía.** No es un error: es «no hay nadie cerca».
- **Errores:** `401 TOKEN_SERVICIO_INVALIDO` sin el encabezado o con un valor distinto, con el mismo mensaje en los dos casos. `400` con parámetros inválidos, repetidos o desconocidos.
- **Token de servicio.** Se compara su SHA-256 en tiempo constante y nunca se loguea ni se devuelve. El JWT de un usuario no abre esta ruta.

### `GET /health` y `GET /ready`

Los de `platform`. `/ready` responde 503 si Postgres no responde o si hay migraciones pendientes.

## Versión ingenua (`UBICACION_ESTRATEGIA=ingenua`)

Es la línea de base que pide 6.6 para medir con k6:

- **Pings.** Cada ping es un `INSERT` en `pings(driver_id, lat, lng, recorded_at)`, aunque el chofer mande uno cada 2 s. Es también el historial.
- **Búsqueda.** Trae la última posición de **todos** los choferes vigentes (`DISTINCT ON (driver_id)`, que usa el índice `(driver_id, recorded_at DESC)`). Después calcula la distancia (haversine) y ordena **en JavaScript**, dentro del event loop. No hay índice geográfico.
- **Estrategia `memoria`.** Sirve para los tests y para correr sin base.
- **Estrategia `optimizada`.** Con Redis GEO, entra en el PR de la tarea pesada. Implementa el mismo puerto (`RepositorioUbicaciones`) y tiene que pasar los mismos tests (`tests/soporte/casos-compartidos.ts`). No cambia el contrato ni las rutas.

Queda pendiente para la tarea pesada: la retención del historial, el límite de pedidos en `/ubicaciones` y `/metrics`.

## Contrato con dispatch (a revisar con Iván)

dispatch ya tiene el puerto `BuscadorCandidatos.buscar(origen, { excluir, limite })`. Lo llama **fuera de la transacción** al crear la solicitud y en el barrido de ofertas vencidas. El PR de integración agrega un adaptador HTTP que llama a `GET /interno/candidatos`.

**Decisiones a acordar antes de integrar:**

1. **Token de servicio.** Propuesta: un secreto compartido en `X-Token-Servicio` (`LOCATION_TOKEN_SERVICIO` en los dos servicios). La alternativa es un JWT de servicio emitido por identity, pero suma un rol nuevo y cambios en identity y en `platform`.
2. **Timeout del adaptador.** Propuesta: 1 s.
3. **Si location no responde** (timeout, error de red o 5xx):
   - `POST /solicitudes` responde `503 UBICACION_NO_DISPONIBLE` y **no crea el viaje**. Falla cerrado, y como la búsqueda va antes de la transacción, no queda nada a medias.
   - El barrido **no** marca `SIN_CHOFERES`: `infra/barrido.ts` ya registra el error y reintenta en la pasada siguiente. Mientras tanto, la oferta vencida no se puede aceptar, porque el vencimiento se decide con el reloj.
   - Un 4xx de location es un error de programación en dispatch: se loguea y también da 503.
4. **`excluir`.** Lo resuelve dispatch: location no recibe la lista de choferes ya ofrecidos.

### Qué pasa si dispatch descarta todo el primer lote

dispatch filtra a los candidatos por disponibilidad, viaje activo, flota y zona. Puede pasar que los N más cercanos no sirvan, aunque haya choferes aptos un poco más lejos. Si dispatch pidiera un solo lote, marcaría `SIN_CHOFERES` de más.

**Propuesta para el PR de integración, lotes crecientes:**

1. Pedir `limite = necesarios + excluidos`, con un mínimo de 10.
2. Filtrar en dispatch: excluidos, no disponibles, con viaje activo, de otra flota o zona.
3. Si quedan suficientes, ofrecer.
4. Si no alcanzan y location devolvió el lote **completo** (tantos como `limite`), puede haber más: pedir de nuevo con el doble de `limite`, hasta el máximo de 100.
5. Si location devolvió **menos** que `limite`, no hay más vigentes en el radio: se ofrece a los que quedaron y, si no queda ninguno, `SIN_CHOFERES`.

Son como máximo 5 pedidos (10, 20, 40, 80 y 100) y no hace falta cambiar este contrato. Si el filtro de flota y zona se vuelve el cuello de botella, la mejora sería mandarle a location la zona del origen: eso sí cambia el contrato, y no hace falta para empezar.

### Para revisar con Iván: el tope por consulta y qué pasa si se agota

**El tope.** location devuelve como máximo **100 candidatos por consulta** (`LIMITE_CANDIDATOS_MAX` en `packages/contracts/src/location.ts`) y busca en un radio máximo de 50 km.

- Acota la respuesta y el trabajo por pedido, para que una consulta no pueda pedir los 500 choferes del simulador.
- En la versión ingenua el costo casi no depende del tope, porque igual recorre todas las posiciones vigentes. En la optimizada (`GEOSEARCH ... COUNT n`) sí crece con `n`.
- Hay que confirmar si 100 alcanza: dispatch ofrece a 3 choferes por tanda (`OFERTAS_SIMULTANEAS`).

**El caso borde.** dispatch pide los 100 más cercanos y su filtro (no disponible, con viaje activo, de otra flota o de otra zona) los descarta **a todos**. Puede haber choferes aptos más lejos, pero location no puede devolverlos sin cambiar el contrato.

**Qué hace dispatch hoy:** `ofrecerACandidatos` recibe una lista vacía y pasa la solicitud a `SIN_CHOFERES` en ese mismo momento.

**Propuesta, la más simple:** mantener ese comportamiento también en este caso.

- Que 100 choferes vigentes y cercanos sean todos no aptos indica un problema de datos o de configuración de flotas y zonas, no un faltante de choferes. Insistir no lo arregla.
- dispatch lo registra en el log con un motivo propio (`tope_agotado`, distinto de «location no devolvió nadie»), con la cantidad descartada por cada filtro, para que se vea en las métricas y en la demo.
- El pasajero recibe la misma respuesta que con `SIN_CHOFERES` y puede volver a pedir.

**Alternativas, si a Iván no le cierra:**

- **Seguir buscando:** dejar la solicitud en `BUSCANDO` y que el barrido reintente hasta un plazo, por ejemplo 60 s desde la creación, antes de pasarla a `SIN_CHOFERES`. Cambia el dominio de dispatch, porque hoy una tanda vacía termina la búsqueda.
- **Filtrar en location:** mandar la zona del origen o la flota en la consulta. Cambia el contrato y le hace saber a location de flotas, que hoy no conoce.

Hay que decidir antes de integrar:

1. si el tope de 100 alcanza;
2. si tope agotado sin aptos equivale a `SIN_CHOFERES` o a seguir buscando;
3. el nombre del motivo en el log.

## Levantarlo desde PowerShell

Requisitos: lo de [docs/identity.md](identity.md#levantarlo-desde-powershell) (Docker, `.env`, `npm ci`, clave de identity y seed). Todos los comandos van desde la raíz del repo.

### Primera vez

1. Si tu `.env` es anterior a location, agregale la sección `location` de `.env.example`. `LOCATION_TOKEN_SERVICIO` de ese archivo es **solo para desarrollo**; en cualquier entorno publicado va uno aleatorio.

2. Creá `location_test` **sin borrar datos**. El script de init solo corre con el volumen vacío, así que si tu Postgres ya estaba inicializado no la creó. La base `location` y el usuario `location_svc` ya existen, porque los crea el mismo script. Este comando es idempotente: si la base ya existe, no hace nada.

```powershell
npm run infra:up
"SELECT 'CREATE DATABASE location_test OWNER location_svc' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'location_test')\gexec" | docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1
docker compose exec -T postgres psql -U postgres -c "REVOKE ALL ON DATABASE location_test FROM PUBLIC"
```

   En un volumen nuevo, el script de init ya crea las dos bases. **No hace falta `docker compose down -v`**, que borraría todos los datos.

3. Generá el cliente de Prisma y migrá la base de desarrollo de location:

```powershell
npm run prisma:generate -w @viajes/location
npm run local -- location migrate:deploy
```

### Correr el servicio

Para la prueba manual hacen falta identity y location, cada uno en su propia terminal:

```powershell
npm run local -- identity
```

```powershell
npm run local -- location
```

`npm run local` carga `.env` en un proceso aparte y fija el puerto: location siempre en 3004.

**Con Docker** (sin la prueba manual, porque dentro del Compose el JWKS se busca en el contenedor `identity`):

```powershell
docker compose up -d --build --no-deps location
Invoke-RestMethod http://localhost:3004/ready | ConvertTo-Json -Compress
docker compose stop location
```

Esperado: `{"estado":"listo","chequeos":{"postgres":"ok","migraciones":"ok"}}`. Si dice `migraciones pendientes`, falta el paso 3.

## Prueba manual

En una tercera terminal, desde la raíz del repo. Los bloques comparten variables. Solo se muestran códigos HTTP y datos públicos: ningún token ni contraseña.

**1. Preparar**

```powershell
$identity = 'http://localhost:3001'
$location = 'http://localhost:3004'
$contrasena = (Select-String -Path .env -Pattern '^IDENTITY_SEED_CONTRASENA=(.*)$').Matches[0].Groups[1].Value
$conServicio = @{ 'X-Token-Servicio' = (Select-String -Path .env -Pattern '^LOCATION_TOKEN_SERVICIO=(.*)$').Matches[0].Groups[1].Value }
function Entrar($email) {
  $body = @{ email = $email; contrasena = $contrasena } | ConvertTo-Json
  Invoke-RestMethod -Method Post "$identity/login" -ContentType 'application/json' -Body $body
}
function Estado([scriptblock]$pedido) {
  try { $r = & $pedido; "HTTP $([int]$r.StatusCode)" } catch { "HTTP $([int]$_.Exception.Response.StatusCode)" }
}
function Informar($cabeceras, $cuerpo) {
  Invoke-WebRequest -UseBasicParsing -Method Post "$location/ubicaciones" -ContentType 'application/json' -Headers $cabeceras -Body $cuerpo
}
Invoke-RestMethod "$location/ready" | ConvertTo-Json -Compress
```

Esperado: `"estado":"listo"`.

**2. El chofer informa su posición**

Un punto unos 400 m al norte del Obelisco:

```powershell
$chofer = Entrar 'chofer@viajes.test'
$conChofer = @{ Authorization = "Bearer $($chofer.token)" }
Estado { Informar $conChofer (@{ lat = -34.6001; lng = -58.3816 } | ConvertTo-Json) }
```

Esperado: `HTTP 204`.

**3. dispatch pregunta quién está cerca del Obelisco**

```powershell
(Invoke-RestMethod "$location/interno/candidatos?lat=-34.6037&lng=-58.3816&limite=5" -Headers $conServicio).candidatos | Format-List
```

Esperado: el chofer de prueba (`00000000-0000-4000-8000-000000000002`) con `distanciaMetros` cerca de 400.

**4. Rechazos**

```powershell
$pasajero = Entrar 'pasajero@viajes.test'
$posicion = @{ lat = -34.6; lng = -58.38 } | ConvertTo-Json
# Un pasajero no informa ubicación: 403
Estado { Informar @{ Authorization = "Bearer $($pasajero.token)" } $posicion }
# Nadie informa la posición de otro chofer: 400
Estado { Informar $conChofer (@{ lat = -34.6; lng = -58.38; choferId = '00000000-0000-4000-8000-000000000099' } | ConvertTo-Json) }
# La ruta interna sin token de servicio: 401
Estado { Invoke-WebRequest -UseBasicParsing "$location/interno/candidatos?lat=-34.6&lng=-58.38" }
# Tampoco con el token de un usuario: 401
Estado { Invoke-WebRequest -UseBasicParsing "$location/interno/candidatos?lat=-34.6&lng=-58.38" -Headers $conChofer }
# Coordenada imposible: 400
Estado { Informar $conChofer (@{ lat = 95; lng = 0 } | ConvertTo-Json) }
```

Esperado: `HTTP 403`, `HTTP 400`, `HTTP 401`, `HTTP 401` y `HTTP 400`.

**5. El chofer fantasma desaparece**

Opcional, tarda 30 segundos:

```powershell
Start-Sleep -Seconds 31
(Invoke-RestMethod "$location/interno/candidatos?lat=-34.6037&lng=-58.3816" -Headers $conServicio).candidatos.Count
```

Esperado: `0`, porque el chofer dejó de reportar hace más de `UBICACION_VIGENCIA_SEGUNDOS`.

## Tests

```powershell
npm test -w @viajes/location
npm run test:dominio -w @viajes/location
```

- `test:dominio` no necesita Docker.
- `npm test` usa la base `location_test` (ver [Primera vez](#primera-vez)).
- Las reglas de búsqueda están en `tests/soporte/casos-compartidos.ts` y corren contra cada estrategia: hoy, memoria e ingenua.

## Lo que sigue

1. **Integración con dispatch** (Iván, una vez acordado el contrato): adaptador HTTP de `BuscadorCandidatos` con timeout, `503` si location no responde, lotes crecientes y variables en el Compose.
2. **Tarea pesada** (Maxi):
   - estrategia `optimizada` con Redis `GEOADD`/`GEOSEARCH`, vencimiento e historial por cola con escritura en lotes;
   - `/metrics` con el lag del event loop;
   - `carga/choferes.js` (500 choferes cada 2 s) con un seed de 500 tokens de chofer;
   - primera medición en `docs/mediciones.md`.
3. **Después:**
   - límite de pedidos en `/ubicaciones`;
   - retención del historial;
   - publicación por Redis para el seguimiento, con su regla de privacidad;
   - ADR 0005 y 0008.
