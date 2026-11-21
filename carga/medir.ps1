# Una corrida de medición de location en el entorno aislado de carga.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File carga/medir.ps1 -Estrategia ingenua -Corrida 1
#
# Hace todo el ciclo: entorno de carga arriba, migración, limpieza, location reiniciado con la
# estrategia pedida, k6, muestras de docker stats, foto de /metrics, espera a que el historial termine
# de escribirse y conteo de filas. Deja todo en docs/mediciones/<fecha>/<estrategia>-<corrida>/.
param(
  [Parameter(Mandatory = $true)][ValidateSet('ingenua', 'optimizada')][string]$Estrategia,
  [int]$Corrida = 1,
  [int]$Medicion = 300,
  [int]$Calentamiento = 30,
  [string]$Fecha = (Get-Date -Format 'yyyy-MM-dd')
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
$base = 'http://127.0.0.1:53004'

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

Paso "migración de location_carga"
$env:LOCATION_DATABASE_URL = "postgresql://carga:$($env:CARGA_PG_PASSWORD)@127.0.0.1:55434/location_carga"
npm run migrate:deploy -w @viajes/location --silent 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error 'falló la migración de la base de carga'; exit 1 }
Remove-Item Env:LOCATION_DATABASE_URL

Paso "limpieza (solo entorno de carga)"
docker @compose stop location 2>$null | Out-Null
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

Paso "muestras de docker stats cada 5 s"
$stats = Join-Path $salida 'docker-stats.csv'
'hora,contenedor,cpu,memoria' | Set-Content -LiteralPath $stats -Encoding UTF8
$muestreo = Start-Job -ArgumentList $stats -ScriptBlock {
  param($archivo)
  while ($true) {
    $hora = Get-Date -Format 'HH:mm:ss'
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' viajes-carga-location-1 viajes-carga-postgres-1 viajes-carga-redis-1 |
      ForEach-Object { "$hora,$_" } | Add-Content -LiteralPath $archivo -Encoding UTF8
    Start-Sleep -Seconds 5
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
  commit            = (git rev-parse --short HEAD)
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $salida 'conteos.json') -Encoding UTF8

Paso "apagado ordenado de location (SIGTERM)"
docker @compose stop location | Out-Null
docker logs viajes-carga-location-1 2>&1 | Select-Object -Last 20 | Set-Content -LiteralPath (Join-Path $salida 'location-log.txt') -Encoding UTF8

Paso "listo: $salida"
Get-Content -LiteralPath (Join-Path $salida 'conteos.json')
