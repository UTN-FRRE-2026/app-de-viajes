# Una corrida de medición de location en el entorno aislado de carga.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File carga/medir.ps1 -Estrategia ingenua -Corrida 1
#
# Hace todo el ciclo: entorno de carga arriba, migración, limpieza, location reiniciado con la
# estrategia pedida, k6, muestras de docker stats, foto de /metrics, espera a que el historial termine
# de escribirse y conteo de filas. Deja todo en docs/mediciones/<fecha>/<estrategia>-<corrida>/.
#
# Con -Solicitudes, además levanta dispatch de carga y corre carga/solicitudes.js en paralelo con k6:
# una solicitud real de punta a punta (crear, oferta por SSE, aceptar, cancelar) durante la fase de
# medición. Es una prueba piloto de latencia bajo carga (ver carga/README.md, «Solicitud real»).
param(
  [Parameter(Mandatory = $true)][ValidateSet('ingenua', 'optimizada')][string]$Estrategia,
  [int]$Corrida = 1,
  [int]$Medicion = 300,
  [int]$Calentamiento = 30,
  [string]$Fecha = (Get-Date -Format 'yyyy-MM-dd'),
  [switch]$Solicitudes
)

# 'Continue' y no 'Stop': en PowerShell 5.1, con 'Stop', cualquier línea que un programa externo
# escriba en stderr (el progreso de Docker o de Prisma) corta el script. Cada paso revisa $LASTEXITCODE.
$ErrorActionPreference = 'Continue'
$raiz = Split-Path -Parent $PSScriptRoot
$carga = Join-Path $raiz 'carga'
$secretos = Join-Path $carga '.secretos'
$salida = Join-Path $raiz "docs/mediciones/$Fecha/$Estrategia-$Corrida"
$compose = @('compose', '-p', 'viajes-carga', '-f', (Join-Path $carga 'compose.yml'), '--env-file', (Join-Path $secretos 'carga.env'))
$k6 = 'grafana/k6:1.8.2'
# Puertos publicados en 127.0.0.1, los mismos que usa compose.yml. Por defecto quedan fuera del rango
# dinámico de Windows (49152-65535), donde Hyper-V y WSL reservan bloques al arrancar y Docker no puede
# publicarlos. Se cambian con CARGA_PG_PUERTO y CARGA_LOCATION_PUERTO.
$puertoPg = if ($env:CARGA_PG_PUERTO) { $env:CARGA_PG_PUERTO } else { '45434' }
$puertoLocation = if ($env:CARGA_LOCATION_PUERTO) { $env:CARGA_LOCATION_PUERTO } else { '43004' }
$puertoDispatch = if ($env:CARGA_DISPATCH_PUERTO) { $env:CARGA_DISPATCH_PUERTO } else { '43005' }
$base = "http://127.0.0.1:$puertoLocation"
$baseDispatch = "http://127.0.0.1:$puertoDispatch"

Set-Location -LiteralPath $raiz
New-Item -ItemType Directory -Force $salida | Out-Null

# Credenciales de carga (solo en este proceso: no quedan en la terminal).
& node (Join-Path $carga 'preparar.mjs')
if ($LASTEXITCODE -ne 0) { exit 1 }
foreach ($linea in Get-Content -LiteralPath (Join-Path $secretos 'carga.env')) {
  if ($linea -match '^([A-Z_]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
$env:ESTRATEGIA = $Estrategia
# /metrics pide Bearer con METRICAS_TOKEN; en el entorno de carga es el mismo secreto (ver compose.yml).
$conMetricas = @{ Authorization = "Bearer $($env:CARGA_TOKEN_SERVICIO)" }

function Paso([string]$texto) { Write-Output ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $texto) }

# Valor de una serie de /metrics, con etiquetas o sin ellas (`nombre{servicio="location"} 3` o `nombre 3`).
# Si la serie no está, la corrida se corta: leerla como 0 daría por terminado el drenaje sin que lo esté.
function Leer-Serie([string]$texto, [string]$nombre) {
  $m = [regex]::Match($texto, "(?m)^$([regex]::Escape($nombre))(\{[^}]*\})?[ \t]+([0-9.eE+-]+)[ \t]*\r?$")
  if (-not $m.Success) {
    Write-Error "falta la serie $nombre en /metrics de location: no se puede validar el historial"
    exit 1
  }
  return [double]::Parse($m.Groups[2].Value, [Globalization.CultureInfo]::InvariantCulture)
}

Paso "infraestructura de carga"
docker @compose up -d --wait postgres redis jwks | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error 'no levantó la infraestructura de carga'; exit 1 }

# Migra una base de carga con Prisma. En Windows, justo después de que `up --wait` crea o recrea
# Postgres, el puerto publicado puede tardar unos segundos en responder aunque el contenedor ya esté
# healthy, y Prisma da P1001 («Can't reach database server»). Solo ese error se reintenta, hasta 10
# veces cada 2 s. Cualquier otro (contraseña, migración rota) corta enseguida. La salida se muestra sin
# la contraseña. `$variable` es la que lee el prisma.config.ts del servicio.
function Migrar([string]$servicio, [string]$variable, [string]$baseDatos) {
  Paso "migración de $baseDatos"
  [Environment]::SetEnvironmentVariable($variable, "postgresql://carga:$($env:CARGA_PG_PASSWORD)@127.0.0.1:$puertoPg/$baseDatos", 'Process')
  $intentos = 10
  $migrada = $false
  for ($intento = 1; $intento -le $intentos; $intento++) {
    $salidaMigracion = @(npm run migrate:deploy -w "@viajes/$servicio" --silent 2>&1 |
        ForEach-Object { "$_".Replace($env:CARGA_PG_PASSWORD, '***') })
    if ($LASTEXITCODE -eq 0) { $migrada = $true; break }
    if (-not ($salidaMigracion -match 'P1001') -or $intento -eq $intentos) { break }
    Paso "Postgres todavía no responde en 127.0.0.1:$puertoPg (P1001): reintento $($intento + 1) de $intentos en 2 s"
    Start-Sleep -Seconds 2
  }
  [Environment]::SetEnvironmentVariable($variable, $null, 'Process')
  if (-not $migrada) {
    $salidaMigracion | Select-Object -Last 8 | ForEach-Object { Write-Output "  $_" }
    Write-Error "falló la migración de $baseDatos"
    exit 1
  }
}

Migrar 'location' 'LOCATION_DATABASE_URL' 'location_carga'

if ($Solicitudes) {
  # La base de dispatch vive en el mismo Postgres de carga. CREATE DATABASE no admite IF NOT EXISTS.
  $existe = (docker exec viajes-carga-postgres-1 psql -U carga -d location_carga -Atc "SELECT 1 FROM pg_database WHERE datname = 'dispatch_carga'")
  if ($existe -ne '1') {
    docker exec viajes-carga-postgres-1 psql -U carga -d location_carga -qc 'CREATE DATABASE dispatch_carga' | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Error 'no se pudo crear dispatch_carga'; exit 1 }
  }
  Migrar 'dispatch' 'DATABASE_URL' 'dispatch_carga'
}

Paso "limpieza (solo entorno de carga)"
docker @compose stop location dispatch 2>$null | Out-Null
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $carga 'limpiar.ps1')
if ($LASTEXITCODE -ne 0) { exit 1 }

Paso "location con estrategia $Estrategia"
docker @compose up -d --build --force-recreate --wait location | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error 'location de carga no quedó healthy'; exit 1 }
$listo = $false
for ($i = 0; $i -lt 60 -and -not $listo; $i++) {
  try { $listo = (Invoke-RestMethod "$base/ready").estado -eq 'listo' } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $listo) { Write-Error 'location de carga no quedó listo'; exit 1 }

if ($Solicitudes) {
  Paso "dispatch de carga"
  docker @compose up -d --build --force-recreate --wait dispatch | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Error 'dispatch de carga no quedó healthy'; exit 1 }
  $listo = $false
  for ($i = 0; $i -lt 60 -and -not $listo; $i++) {
    try { $listo = (Invoke-RestMethod "$baseDispatch/ready").estado -eq 'listo' } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $listo) { Write-Error 'dispatch de carga no quedó listo'; exit 1 }
}

Paso "muestras de docker stats cada 5 s"
$stats = Join-Path $salida 'docker-stats.csv'
'hora,contenedor,cpu,memoria' | Set-Content -LiteralPath $stats -Encoding UTF8
$contenedores = @('viajes-carga-location-1', 'viajes-carga-postgres-1', 'viajes-carga-redis-1')
if ($Solicitudes) { $contenedores += 'viajes-carga-dispatch-1' }
$muestreo = Start-Job -ArgumentList $stats, $contenedores -ScriptBlock {
  param($archivo, $nombres)
  while ($true) {
    $hora = Get-Date -Format 'HH:mm:ss'
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' @nombres |
      ForEach-Object { "$hora,$_" } | Add-Content -LiteralPath $archivo -Encoding UTF8
    Start-Sleep -Seconds 5
  }
}

$flujo = $null
if ($Solicitudes) {
  # Arranca antes que k6 y espera sus pings: las solicitudes corren solo en la fase de medición.
  Paso "solicitud real (carga/solicitudes.js) en paralelo, durante la medición"
  $flujo = Start-Job -ArgumentList $carga, $secretos, $salida, $Calentamiento, $Medicion, $env:CARGA_TOKEN_SERVICIO -ScriptBlock {
    param($carga, $secretos, $salida, $calentamiento, $medicion, $token)
    $env:METRICAS_TOKEN = $token
    docker run --rm --network viajes-carga_default `
      -v "${carga}:/scripts:ro" -v "${secretos}:/secretos:ro" -v "${salida}:/resultados" `
      -e METRICAS_TOKEN -e "CALENTAMIENTO_S=$calentamiento" -e "MEDICION_S=$medicion" `
      node:22-alpine node /scripts/solicitudes.js 2>&1
    "codigo=$LASTEXITCODE"
  }
}

Paso "k6: $Calentamiento s de calentamiento + $Medicion s de medición"
$env:TOKEN_SERVICIO = $env:CARGA_TOKEN_SERVICIO
$inicio = Get-Date
# -e NOMBRE sin valor: Docker toma el valor de este proceso, así el token no aparece en la línea de comando.
docker run --rm --network viajes-carga_default `
  -v "${carga}:/scripts:ro" -v "${secretos}:/secretos:ro" -v "${salida}:/resultados" `
  -e TOKEN_SERVICIO -e "CALENTAMIENTO_S=$Calentamiento" -e "MEDICION_S=$Medicion" `
  $k6 run --quiet /scripts/ubicaciones.js | Tee-Object -FilePath (Join-Path $salida 'k6.txt')
$codigoK6 = $LASTEXITCODE
Remove-Item Env:TOKEN_SERVICIO
Stop-Job $muestreo; Remove-Job $muestreo -Force

$resumenSolicitudes = $null
if ($flujo) {
  Paso "esperando el fin de la solicitud real"
  Wait-Job $flujo -Timeout 120 | Out-Null
  $salidaFlujo = @(Receive-Job $flujo)
  Remove-Job $flujo -Force
  $salidaFlujo | Set-Content -LiteralPath (Join-Path $salida 'solicitudes-log.txt') -Encoding UTF8
  $archivoFlujo = Join-Path $salida 'solicitudes.json'
  if (-not (Test-Path -LiteralPath $archivoFlujo)) {
    $salidaFlujo | Select-Object -Last 10 | ForEach-Object { Write-Output "  $_" }
    Write-Error 'la solicitud real no dejó resultados'
    exit 1
  }
  $resumenSolicitudes = (Get-Content -LiteralPath $archivoFlujo -Raw | ConvertFrom-Json).resumen
}

Paso "foto de /metrics"
$metricas = (Invoke-WebRequest -UseBasicParsing "$base/metrics" -Headers $conMetricas).Content
$metricas.TrimEnd() | Set-Content -LiteralPath (Join-Path $salida 'metrics.txt') -Encoding UTF8

$drenajeMs = 0
if ($Estrategia -eq 'optimizada') {
  Paso "esperando que el historial termine de escribirse"
  $desde = Get-Date
  $drenado = $false
  for ($i = 0; $i -lt 240 -and -not $drenado; $i++) {
    $m = (Invoke-WebRequest -UseBasicParsing "$base/metrics" -Headers $conMetricas).Content
    $cola = Leer-Serie $m 'location_historial_en_cola'
    $pend = Leer-Serie $m 'location_historial_pendientes'
    $drenado = ($cola -eq 0 -and $pend -eq 0)
    if (-not $drenado) { Start-Sleep -Milliseconds 500 }
  }
  $drenajeMs = [int]((Get-Date) - $desde).TotalMilliseconds
  if (-not $drenado) { Write-Error 'el historial no terminó de escribirse en 2 minutos'; exit 1 }
}

Paso "conteo del historial"
$filas = (docker exec viajes-carga-postgres-1 psql -U carga -d location_carga -Atc "SELECT count(*) || ',' || count(stream_id) || ',' || count(DISTINCT stream_id) FROM pings").Trim().Split(',')
$descartados = 0
if ($Estrategia -eq 'optimizada') { $descartados = [int](Leer-Serie $metricas 'location_historial_descartados_total') }

$resumen = Get-Content -LiteralPath (Join-Path $salida 'resumen-k6.json') -Raw | ConvertFrom-Json
function Contar([string]$m) { $x = $resumen.metrics.$m; if ($x) { [int]$x.values.count } else { 0 } }
[ordered]@{
  estrategia        = $Estrategia
  corrida           = $Corrida
  inicio            = $inicio.ToString('s')
  medicion_s        = $Medicion
  calentamiento_s   = $Calentamiento
  pings_enviados    = Contar 'pings_enviados'
  pings_aceptados   = Contar 'pings_aceptados'
  pings_fallidos    = Contar 'pings_fallidos'
  pings_omitidos_k6 = Contar 'dropped_iterations{scenario:pings}'
  historial_filas   = [int]$filas[0]
  historial_stream_ids_distintos = [int]$filas[2]
  historial_descartados = $descartados
  historial_drenaje_ms  = $drenajeMs
  codigo_k6         = $codigoK6
  solicitudes       = $resumenSolicitudes
  commit            = (git rev-parse --short HEAD)
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $salida 'conteos.json') -Encoding UTF8

Paso "apagado ordenado de location (SIGTERM)"
docker @compose stop location | Out-Null
docker logs viajes-carga-location-1 2>&1 | Select-Object -Last 20 | Set-Content -LiteralPath (Join-Path $salida 'location-log.txt') -Encoding UTF8
if ($Solicitudes) {
  docker @compose stop dispatch | Out-Null
  docker logs viajes-carga-dispatch-1 2>&1 | Select-Object -Last 20 | Set-Content -LiteralPath (Join-Path $salida 'dispatch-log.txt') -Encoding UTF8
}

Paso "listo: $salida"
Get-Content -LiteralPath (Join-Path $salida 'conteos.json')
