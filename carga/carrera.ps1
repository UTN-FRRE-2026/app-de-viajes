# Carrera de la asignación única (6.3) con k6, contra el sistema en contenedores del entorno aislado.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File carga/carrera.ps1 -Corrida 1
#
# 50 choferes (los primeros 50 de tokens.json) informan su posición en Córdoba, el pasajero de
# tokens-solicitudes.json pide un viaje ahí, y dispatch le ofrece el viaje a los 50. Las ofertas se
# leen de dispatch_carga, k6 (carga/carrera.js) dispara las 50 aceptaciones juntas, y después se
# comprueba en PostgreSQL que haya UNA sola asignación activa y que sea la del ganador. Por último el
# pasajero cancela, lo que libera a los dos. Deja la evidencia (sin credenciales) en
# docs/mediciones/<fecha>/carrera-<corrida>/ y termina con error si algo no coincide.
param(
  [int]$Corrida = 1,
  [string]$Fecha = (Get-Date -Format 'yyyy-MM-dd')
)

# 'Continue' y no 'Stop': en PowerShell 5.1, con 'Stop', cualquier línea que un programa externo
# escriba en stderr corta el script. Cada paso revisa $LASTEXITCODE.
$ErrorActionPreference = 'Continue'
$raiz = Split-Path -Parent $PSScriptRoot
$carga = Join-Path $raiz 'carga'
$secretos = Join-Path $carga '.secretos'
$salida = Join-Path $raiz "docs/mediciones/$Fecha/carrera-$Corrida"
$compose = @('compose', '-p', 'viajes-carga', '-f', (Join-Path $carga 'compose.yml'), '--env-file', (Join-Path $secretos 'carga.env'))
$k6 = 'grafana/k6:1.8.2'
$puertoPg = if ($env:CARGA_PG_PUERTO) { $env:CARGA_PG_PUERTO } else { '45434' }
$puertoLocation = if ($env:CARGA_LOCATION_PUERTO) { $env:CARGA_LOCATION_PUERTO } else { '43004' }
$puertoDispatch = if ($env:CARGA_DISPATCH_PUERTO) { $env:CARGA_DISPATCH_PUERTO } else { '43005' }
$baseLocation = "http://127.0.0.1:$puertoLocation"
$baseDispatch = "http://127.0.0.1:$puertoDispatch"
$CHOFERES = 50
# El mismo origen que carga/solicitudes.js: lejos de cualquier otro chofer.
$ORIGEN = @{ lat = -31.4201; lng = -64.1888 }
$DESTINO = @{ lat = -31.4135; lng = -64.1811 }

Set-Location -LiteralPath $raiz
if (Test-Path -LiteralPath $salida) { Remove-Item -Recurse -Force -LiteralPath $salida }
New-Item -ItemType Directory -Force $salida | Out-Null
$sinBom = New-Object System.Text.UTF8Encoding $false
function Guardar([string]$nombre, [string]$texto) { [IO.File]::WriteAllText((Join-Path $salida $nombre), $texto, $sinBom) }
function Paso([string]$texto) { Write-Output ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $texto) }
function Fallar([string]$texto) { Write-Error "carrera: $texto"; exit 1 }

# Credenciales de carga (solo en este proceso).
& node (Join-Path $carga 'preparar.mjs')
if ($LASTEXITCODE -ne 0) { exit 1 }
foreach ($linea in Get-Content -LiteralPath (Join-Path $secretos 'carga.env')) {
  if ($linea -match '^([A-Z_]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
$env:ESTRATEGIA = 'optimizada'
# 50 ofertas por solicitud (el máximo de dispatch) y vigencia larga: así ninguna vence entre crearla y aceptarla.
$env:CARGA_OFERTAS_SIMULTANEAS = "$CHOFERES"
$env:CARGA_OFERTA_TTL_SEGUNDOS = '120'

# --- HTTP con HttpClient: lee el cuerpo también en los 4xx y 5xx (Invoke-WebRequest de 5.1 no). ---
Add-Type -AssemblyName System.Net.Http
$http = [System.Net.Http.HttpClient]::new()
$http.Timeout = [TimeSpan]::FromSeconds(10)
function Pedir([string]$metodo, [string]$url, [string]$token, $cuerpo, [string]$clave) {
  $pedido = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($metodo), $url)
  $pedido.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $token)
  if ($clave) { $pedido.Headers.Add('Idempotency-Key', $clave) }
  if ($null -ne $cuerpo) {
    $pedido.Content = [System.Net.Http.StringContent]::new(($cuerpo | ConvertTo-Json -Compress -Depth 5), [Text.Encoding]::UTF8, 'application/json')
  }
  try {
    $res = $http.SendAsync($pedido).GetAwaiter().GetResult()
    $texto = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $json = $null
    if ($texto) { try { $json = $texto | ConvertFrom-Json } catch { $json = $null } }
    return @{ estado = [int]$res.StatusCode; json = $json }
  } catch {
    return @{ estado = 0; json = $null }
  }
}
# Una operación con efecto: ante un error de red, un 5xx o un 409 «clave en curso», reintenta con la MISMA clave.
function ConClave([string]$metodo, [string]$url, [string]$token, $cuerpo) {
  $clave = [guid]::NewGuid().ToString()
  for ($intento = 0; $intento -le 3; $intento++) {
    if ($intento -gt 0) { Start-Sleep -Milliseconds (200 * $intento) }
    $r = Pedir $metodo $url $token $cuerpo $clave
    $enCurso = $r.estado -eq 409 -and $r.json.error.code -eq 'CLAVE_IDEMPOTENCIA_EN_CURSO'
    if ($r.estado -ne 0 -and $r.estado -lt 500 -and -not $enCurso) { return $r }
  }
  return $r
}

# --- PostgreSQL de carga (dispatch_carga), con la consulta y su salida guardadas en postgres.txt ---
$evidenciaSql = New-Object System.Text.StringBuilder
function Sql([string]$titulo, [string]$consulta) {
  $filas = @(docker exec viajes-carga-postgres-1 psql -U carga -d dispatch_carga -At -F '|' -c $consulta)
  [void]$evidenciaSql.AppendLine("-- $titulo").AppendLine($consulta).AppendLine(($filas -join "`n")).AppendLine()
  # La coma conserva el arreglo aunque tenga una sola fila: sin ella, PowerShell devuelve el texto
  # suelto y $filas[0] sería su primer carácter.
  return ,$filas
}

# Migra una base de carga (igual que medir.ps1): reintenta solo P1001, el puerto que todavía no responde.
function Migrar([string]$servicio, [string]$variable, [string]$baseDatos) {
  Paso "migración de $baseDatos"
  [Environment]::SetEnvironmentVariable($variable, "postgresql://carga:$($env:CARGA_PG_PASSWORD)@127.0.0.1:$puertoPg/$baseDatos", 'Process')
  $migrada = $false
  for ($intento = 1; $intento -le 10; $intento++) {
    $salidaMigracion = @(npm run migrate:deploy -w "@viajes/$servicio" --silent 2>&1 |
        ForEach-Object { "$_".Replace($env:CARGA_PG_PASSWORD, '***') })
    if ($LASTEXITCODE -eq 0) { $migrada = $true; break }
    if (-not ($salidaMigracion -match 'P1001') -or $intento -eq 10) { break }
    Paso "Postgres todavía no responde en 127.0.0.1:$puertoPg (P1001): reintento $($intento + 1) de 10 en 2 s"
    Start-Sleep -Seconds 2
  }
  [Environment]::SetEnvironmentVariable($variable, $null, 'Process')
  if (-not $migrada) {
    $salidaMigracion | Select-Object -Last 8 | ForEach-Object { Write-Output "  $_" }
    Fallar "falló la migración de $baseDatos"
  }
}

function EsperarListo([string]$base, [string]$nombre) {
  for ($i = 0; $i -lt 60; $i++) {
    try { if ((Invoke-RestMethod "$base/ready").estado -eq 'listo') { return } } catch { Start-Sleep -Milliseconds 500 }
  }
  Fallar "$nombre de carga no quedó listo"
}

# ================== Entorno ==================

Paso "imagen de k6 ($k6)"
docker image inspect $k6 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  docker pull $k6 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fallar "no se pudo bajar $k6" }
}

Paso "infraestructura de carga"
docker @compose up -d --wait postgres redis jwks | Out-Null
if ($LASTEXITCODE -ne 0) { Fallar 'no levantó la infraestructura de carga' }
Migrar 'location' 'LOCATION_DATABASE_URL' 'location_carga'
$existe = (docker exec viajes-carga-postgres-1 psql -U carga -d location_carga -Atc "SELECT 1 FROM pg_database WHERE datname = 'dispatch_carga'")
if ($existe -ne '1') {
  docker exec viajes-carga-postgres-1 psql -U carga -d location_carga -qc 'CREATE DATABASE dispatch_carga' | Out-Null
  if ($LASTEXITCODE -ne 0) { Fallar 'no se pudo crear dispatch_carga' }
}
Migrar 'dispatch' 'DATABASE_URL' 'dispatch_carga'

Paso "limpieza (solo entorno de carga)"
docker @compose stop location dispatch 2>$null | Out-Null
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $carga 'limpiar.ps1')
if ($LASTEXITCODE -ne 0) { exit 1 }

# Flotas y zonas de carga (carga/flotas.sql): sin esto, el filtro de candidatos de dispatch descarta a
# todos los choferes de carga. Va después de limpiar.ps1, que vacía dispatch_carga.
Get-Content -LiteralPath (Join-Path $carga 'flotas.sql') -Raw | docker exec -i viajes-carga-postgres-1 psql -U carga -d dispatch_carga -v ON_ERROR_STOP=1 -q | Out-Null
if ($LASTEXITCODE -ne 0) { Fallar 'no se pudieron cargar las flotas y zonas de carga' }

Paso "location (optimizada) y dispatch (50 ofertas por solicitud)"
docker @compose up -d --build --force-recreate --wait location | Out-Null
if ($LASTEXITCODE -ne 0) { Fallar 'location de carga no quedó healthy' }
EsperarListo $baseLocation 'location'
docker @compose up -d --build --force-recreate --wait dispatch | Out-Null
if ($LASTEXITCODE -ne 0) { Fallar 'dispatch de carga no quedó healthy' }
EsperarListo $baseDispatch 'dispatch'

# ================== Preparación: 50 choferes vigentes, la solicitud y sus 50 ofertas ==================

# Con los servicios listos, recién ahora los pings: quedan vigentes (30 s) cuando se crea la solicitud.
Paso "$CHOFERES choferes informan su posición"
$tokens = Get-Content -LiteralPath (Join-Path $secretos 'tokens.json') -Raw | ConvertFrom-Json
$cultura = [Globalization.CultureInfo]::InvariantCulture
for ($i = 0; $i -lt $CHOFERES; $i++) {
  # Cada uno 1 m más al norte que el anterior: todos dentro del radio y sin empates.
  $posicion = @{ lat = $ORIGEN.lat + $i / 111195.0; lng = $ORIGEN.lng }
  $r = Pedir 'POST' "$baseLocation/ubicaciones" $tokens[$i] $posicion $null
  if ($r.estado -ne 204) { Fallar "el ping del chofer $($i + 1) respondió $($r.estado)" }
}

Paso "el pasajero pide el viaje"
$flujo = Get-Content -LiteralPath (Join-Path $secretos 'tokens-solicitudes.json') -Raw | ConvertFrom-Json
$creada = ConClave 'POST' "$baseDispatch/solicitudes" $flujo.pasajero @{ origen = $ORIGEN; destino = $DESTINO }
if ($creada.estado -ne 201) { Fallar "crear la solicitud respondió $($creada.estado) $($creada.json.error.code)" }
if ($creada.json.estado -ne 'BUSCANDO') { Fallar "la solicitud quedó en $($creada.json.estado), no en BUSCANDO" }
$solicitudId = $creada.json.id

Paso "las ofertas, leídas de dispatch_carga"
$filasOfertas = Sql 'ofertas pendientes de la solicitud' "SELECT id, driver_id FROM offers WHERE request_id = '$solicitudId' AND status = 'PENDIENTE' ORDER BY driver_id"
if ($filasOfertas.Count -ne $CHOFERES) { Fallar "hay $($filasOfertas.Count) ofertas pendientes, no $CHOFERES" }
$ofertas = foreach ($fila in $filasOfertas) {
  $ofertaId, $choferId = $fila.Split('|')
  # Los choferes de carga son 00000000-0000-4000-8000-c0000000XXXX, con XXXX = índice + 1 en hexadecimal.
  $indice = [Convert]::ToInt32($choferId.Substring(32), 16) - 1
  if ($indice -lt 0 -or $indice -ge $CHOFERES) { Fallar "la oferta $ofertaId es de un chofer que no se preparó ($choferId)" }
  [ordered]@{ ofertaId = $ofertaId; choferId = $choferId; indiceToken = $indice; clave = [guid]::NewGuid().ToString() }
}
Guardar 'ofertas.json' (ConvertTo-Json @($ofertas) -Depth 3)

# ================== La carrera ==================

Paso "k6: $CHOFERES aceptaciones a la vez"
$salidaK6 = @(docker run --rm --network viajes-carga_default `
    -v "${carga}:/scripts:ro" -v "${secretos}:/secretos:ro" -v "${salida}:/resultados" `
    -e 'DISPATCH_URL=http://dispatch:3005' `
    $k6 run --quiet --log-format raw /scripts/carrera.js 2>&1 | ForEach-Object { "$_" })
$codigoK6 = $LASTEXITCODE
Guardar 'k6.txt' (($salidaK6 | Where-Object { -not $_.StartsWith('RESULTADO ') }) -join "`n")
$lineaResultado = $salidaK6 | Where-Object { $_.StartsWith('RESULTADO ') } | Select-Object -First 1
if (-not $lineaResultado) { $salidaK6 | Select-Object -Last 10 | ForEach-Object { Write-Output "  $_" }; Fallar 'k6 no dejó el resultado' }
$resultadoK6 = $lineaResultado.Substring(10) | ConvertFrom-Json
Guardar 'respuestas.json' ($resultadoK6 | ConvertTo-Json -Depth 5)
$ganador = $resultadoK6.ganador
$ok200 = @($resultadoK6.filas | Where-Object { $_.estado -eq 200 }).Count
$conflictos = @($resultadoK6.filas | Where-Object { $_.estado -eq 409 })
$codigos409 = @($conflictos | ForEach-Object { $_.codigo } | Sort-Object -Unique)

# ================== PostgreSQL, ANTES de cancelar ==================

Paso "verificación en PostgreSQL"
$solicitud = Sql 'la solicitud' "SELECT status, driver_id FROM ride_requests WHERE id = '$solicitudId'"
$asignaciones = Sql 'asignaciones activas (toda la tabla)' 'SELECT driver_id, request_id FROM driver_active_assignment'
$estadosOfertas = Sql 'ofertas por estado' "SELECT status, count(*) FROM offers WHERE request_id = '$solicitudId' GROUP BY status ORDER BY status"
$tripAssigned = Sql 'eventos TripAssigned' "SELECT count(*) FROM outbox WHERE type = 'TripAssigned' AND payload->>'solicitudId' = '$solicitudId'"
$porEstado = [ordered]@{}
foreach ($f in $estadosOfertas) { $estado, $cantidad = $f.Split('|'); $porEstado[$estado] = [int]$cantidad }
$asignacionCoincide = $asignaciones.Count -eq 1 -and $asignaciones[0] -eq "$ganador|$solicitudId" -and $solicitud[0] -eq "ASIGNADO|$ganador"

# ================== Liberar: el pasajero cancela ==================

Paso "el pasajero cancela (libera al ganador y al pasajero)"
$cancelada = ConClave 'POST' "$baseDispatch/solicitudes/$solicitudId/cancelar" $flujo.pasajero @{}
$despues = Sql 'la solicitud después de cancelar' "SELECT status FROM ride_requests WHERE id = '$solicitudId'"
$asignacionesDespues = Sql 'asignaciones activas después de cancelar' 'SELECT count(*) FROM driver_active_assignment'
Guardar 'postgres.txt' $evidenciaSql.ToString()

Paso "apagado de dispatch y location"
docker logs viajes-carga-dispatch-1 2>&1 | Select-Object -Last 30 | ForEach-Object { "$_" } | Set-Content -LiteralPath (Join-Path $salida 'dispatch-log.txt') -Encoding UTF8
docker @compose stop dispatch location | Out-Null

$veredicto = [ordered]@{
  solicitudId         = $solicitudId
  ofertas             = $filasOfertas.Count
  ok200               = $ok200
  conflictos409       = $conflictos.Count
  codigos409          = $codigos409
  ganador             = $ganador
  asignacionesActivas = $asignaciones.Count
  asignacionCoincide  = $asignacionCoincide
  estadosOfertas      = $porEstado
  tripAssigned        = [int]$tripAssigned[0]
  totalLoteMs         = $resultadoK6.totalLoteMs
  sumaDuracionesMs    = $resultadoK6.sumaDuracionesMs
  codigoK6            = $codigoK6
  cancelacion         = $cancelada.estado
  cancelada           = $despues[0] -eq 'CANCELADO_PASAJERO'
  liberados           = [int]$asignacionesDespues[0] -eq 0
  commit              = (git rev-parse --short HEAD)
}
$veredicto.ok = ($veredicto.ok200 -eq 1 -and $veredicto.conflictos409 -eq 49 -and ($codigos409 -join ',') -eq 'SOLICITUD_NO_DISPONIBLE' -and
  $asignacionCoincide -and $porEstado['ACEPTADA'] -eq 1 -and $porEstado['CANCELADA'] -eq 49 -and $veredicto.tripAssigned -eq 1 -and
  $codigoK6 -eq 0 -and $cancelada.estado -eq 200 -and $veredicto.cancelada -and $veredicto.liberados)
Guardar 'resultado.json' ($veredicto | ConvertTo-Json -Depth 4)

Paso "listo: $salida"
Get-Content -LiteralPath (Join-Path $salida 'resultado.json')
if (-not $veredicto.ok) { Fallar 'el resultado no coincide con lo esperado (ver resultado.json)' }
