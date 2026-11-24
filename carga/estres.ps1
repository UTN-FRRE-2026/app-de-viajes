# Rampa de estrés por escalones (escenario B de docs/mediciones.md), en el entorno aislado de carga.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File carga/estres.ps1 -Corrida 1
#
# - location (optimizada) y dispatch de carga, con la base y las claves vacías y carga/flotas.sql.
# - carga/estres-choferes.mjs: los choferes de prueba (300 aptos y 10 no aptos) y las fotos de /metrics
#   en la ventana estable de cada escalón.
# - El fondo de 6.6 (carga/ubicaciones.js: 250 pings/s y 20 búsquedas/s) en un k6 aparte.
# - carga/estres.js: los pasajeros, por escalones. Un umbral incumplido NO corta la corrida: es lo que se
#   busca. k6 termina con 99 en ese caso, y eso cuenta como corrida válida.
# Al final comprueba la corrección en dispatch_carga y deja todo, sin credenciales, en
# docs/mediciones/<fecha>/estres-<corrida>/. Prueba corta: -CalentamientoS 10 -SegundosEtapa 20 -SegundosTransicion 5 -Etapas '1,4'.
param(
  [int]$Corrida = 1,
  [string]$Fecha = (Get-Date -Format 'yyyy-MM-dd'),
  [int]$CalentamientoS = 30,
  [int]$SegundosEtapa = 60,
  [int]$SegundosTransicion = 15,
  [string]$Etapas = '1,2,4,8,16,32',
  [int]$ChoferesAptos = 300
)

# 'Continue' y no 'Stop': en PowerShell 5.1, con 'Stop', cualquier línea que un programa externo
# escriba en stderr corta el script. Cada paso revisa $LASTEXITCODE.
$ErrorActionPreference = 'Continue'
$raiz = Split-Path -Parent $PSScriptRoot
$carga = Join-Path $raiz 'carga'
$secretos = Join-Path $carga '.secretos'
$salida = Join-Path $raiz "docs/mediciones/$Fecha/estres-$Corrida"
$compose = @('compose', '-p', 'viajes-carga', '-f', (Join-Path $carga 'compose.yml'), '--env-file', (Join-Path $secretos 'carga.env'))
$k6 = 'grafana/k6:1.8.2'
$puertoPg = if ($env:CARGA_PG_PUERTO) { $env:CARGA_PG_PUERTO } else { '45434' }
$puertoLocation = if ($env:CARGA_LOCATION_PUERTO) { $env:CARGA_LOCATION_PUERTO } else { '43004' }
$puertoDispatch = if ($env:CARGA_DISPATCH_PUERTO) { $env:CARGA_DISPATCH_PUERTO } else { '43005' }
$baseLocation = "http://127.0.0.1:$puertoLocation"
$baseDispatch = "http://127.0.0.1:$puertoDispatch"
$cantidadEtapas = @($Etapas.Split(',')).Count
$duracionS = $CalentamientoS + $cantidadEtapas * $SegundosEtapa

Set-Location -LiteralPath $raiz
if (Test-Path -LiteralPath $salida) { Remove-Item -Recurse -Force -LiteralPath $salida }
New-Item -ItemType Directory -Force $salida | Out-Null
New-Item -ItemType Directory -Force (Join-Path $salida 'fondo') | Out-Null
function Paso([string]$texto) { Write-Output ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $texto) }
function Fallar([string]$texto) { Write-Error "estres: $texto"; exit 1 }

# Credenciales de carga (solo en este proceso).
& node (Join-Path $carga 'preparar.mjs')
if ($LASTEXITCODE -ne 0) { exit 1 }
foreach ($linea in Get-Content -LiteralPath (Join-Path $secretos 'carga.env')) {
  if ($linea -match '^([A-Z_]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
$env:ESTRATEGIA = 'optimizada'
Remove-Item Env:CARGA_OFERTAS_SIMULTANEAS -ErrorAction SilentlyContinue
Remove-Item Env:CARGA_OFERTA_TTL_SEGUNDOS -ErrorAction SilentlyContinue

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
# Flotas y zonas de carga: sin esto, el filtro de dispatch descarta a todos los choferes de prueba.
Get-Content -LiteralPath (Join-Path $carga 'flotas.sql') -Raw | docker exec -i viajes-carga-postgres-1 psql -U carga -d dispatch_carga -v ON_ERROR_STOP=1 -q | Out-Null
if ($LASTEXITCODE -ne 0) { Fallar 'no se pudieron cargar las flotas y zonas de carga' }

Paso "location (optimizada) y dispatch"
docker @compose up -d --build --force-recreate --wait location | Out-Null
if ($LASTEXITCODE -ne 0) { Fallar 'location de carga no quedó healthy' }
EsperarListo $baseLocation 'location'
docker @compose up -d --build --force-recreate --wait dispatch | Out-Null
if ($LASTEXITCODE -ne 0) { Fallar 'dispatch de carga no quedó healthy' }
EsperarListo $baseDispatch 'dispatch'

# ================== Corrida ==================

Paso "muestras de docker stats cada 5 s"
$stats = Join-Path $salida 'docker-stats.csv'
'hora,contenedor,cpu,memoria' | Set-Content -LiteralPath $stats -Encoding UTF8
$muestreo = Start-Job -ArgumentList $stats -ScriptBlock {
  param($archivo)
  $nombres = @('viajes-carga-dispatch-1', 'viajes-carga-location-1', 'viajes-carga-postgres-1', 'viajes-carga-redis-1')
  while ($true) {
    $hora = (Get-Date).ToUniversalTime().ToString('o')
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' @nombres |
      ForEach-Object { "$hora,$_" } | Add-Content -LiteralPath $archivo -Encoding UTF8
    Start-Sleep -Seconds 5
  }
}

$token = $env:CARGA_TOKEN_SERVICIO
Paso "choferes de prueba ($ChoferesAptos aptos y 10 no aptos) y fotos por escalón"
$companero = Start-Job -ArgumentList $carga, $secretos, $salida, $token, $CalentamientoS, $SegundosEtapa, $SegundosTransicion, $Etapas, $ChoferesAptos -ScriptBlock {
  param($carga, $secretos, $salida, $token, $cal, $segEtapa, $segTransicion, $etapas, $aptos)
  $env:METRICAS_TOKEN = $token
  docker run --rm --network viajes-carga_default `
    -v "${carga}:/scripts:ro" -v "${secretos}:/secretos:ro" -v "${salida}:/resultados" `
    -e METRICAS_TOKEN -e "CALENTAMIENTO_S=$cal" -e "ETAPA_S=$segEtapa" -e "TRANSICION_S=$segTransicion" `
    -e "ETAPAS=$etapas" -e "CHOFERES_APTOS=$aptos" `
    node:22-alpine node /scripts/estres-choferes.mjs 2>&1
  "codigo=$LASTEXITCODE"
}
# Que los choferes se conecten y manden su primera posición antes de los primeros viajes.
Start-Sleep -Seconds 8

Paso "fondo de 6.6 en un k6 aparte: 250 pings/s y 20 búsquedas/s durante $duracionS s"
$fondo = Start-Job -ArgumentList $carga, $secretos, (Join-Path $salida 'fondo'), $token, $CalentamientoS, ($duracionS - $CalentamientoS + 15), $k6 -ScriptBlock {
  param($carga, $secretos, $salidaFondo, $token, $cal, $medicion, $imagen)
  $env:TOKEN_SERVICIO = $token
  docker run --rm --network viajes-carga_default `
    -v "${carga}:/scripts:ro" -v "${secretos}:/secretos:ro" -v "${salidaFondo}:/resultados" `
    -e TOKEN_SERVICIO -e "CALENTAMIENTO_S=$cal" -e "MEDICION_S=$medicion" `
    $imagen run --quiet /scripts/ubicaciones.js 2>&1
  "codigo=$LASTEXITCODE"
}

Paso "k6 estres.js: $CalentamientoS s de calentamiento y escalones de $Etapas viajes/s, $SegundosEtapa s cada uno"
docker run --rm --network viajes-carga_default `
  -v "${carga}:/scripts:ro" -v "${secretos}:/secretos:ro" -v "${salida}:/resultados" `
  -e "CALENTAMIENTO_S=$CalentamientoS" -e "ETAPA_S=$SegundosEtapa" -e "TRANSICION_S=$SegundosTransicion" -e "ETAPAS=$Etapas" `
  $k6 run --quiet /scripts/estres.js 2>&1 | Tee-Object -FilePath (Join-Path $salida 'k6.txt')
$codigoK6 = $LASTEXITCODE
# 99: algún umbral (criterio de degradación) no se cumplió. Es un resultado, no una falla de la corrida.
if ($codigoK6 -ne 0 -and $codigoK6 -ne 99) { Fallar "k6 terminó con $codigoK6" }

Paso "esperando al fondo y a los choferes"
Wait-Job $fondo -Timeout 120 | Out-Null
$salidaFondo = @(Receive-Job $fondo); Remove-Job $fondo -Force
$salidaFondo | Set-Content -LiteralPath (Join-Path $salida 'fondo/k6.txt') -Encoding UTF8
Wait-Job $companero -Timeout 120 | Out-Null
$salidaCompanero = @(Receive-Job $companero); Remove-Job $companero -Force
$salidaCompanero | Set-Content -LiteralPath (Join-Path $salida 'choferes-log.txt') -Encoding UTF8
Stop-Job $muestreo; Remove-Job $muestreo -Force
foreach ($archivo in @('etapas-k6.json', 'etapas-servidor.json', 'choferes.json')) {
  if (-not (Test-Path -LiteralPath (Join-Path $salida $archivo))) {
    $salidaCompanero | Select-Object -Last 10 | ForEach-Object { Write-Output "  $_" }
    Fallar "falta ${archivo}: la evidencia de la corrida no está completa"
  }
}

Paso "corrección en dispatch_carga"
$noAptos = "SELECT ('00000000-0000-4000-8000-b0000000' || lpad(to_hex(i), 4, '0'))::uuid FROM generate_series(301, 310) AS i"
$consulta = @"
SELECT json_build_object(
  'viajes_creados', (SELECT count(*) FROM ride_requests),
  'viajes_activos', (SELECT count(*) FROM ride_requests WHERE status IN ('BUSCANDO', 'ASIGNADO', 'EN_CAMINO', 'EN_CURSO')),
  'asignaciones_activas', (SELECT count(*) FROM driver_active_assignment),
  'ofertas', (SELECT count(*) FROM offers),
  'ofertas_a_no_aptos', (SELECT count(*) FROM offers WHERE driver_id IN ($noAptos)),
  'viajes_de_no_aptos', (SELECT count(*) FROM ride_requests WHERE driver_id IN ($noAptos)),
  'viajes_fuera_de_cordoba', (SELECT count(*) FROM ride_requests WHERE zone_id IS DISTINCT FROM '00000000-0000-4000-8000-0000000ca5c0'),
  'asignados_sin_flota', (SELECT count(*) FROM ride_requests WHERE driver_id IS NOT NULL AND fleet_id IS NULL)
)
"@
$correccion = (docker exec viajes-carga-postgres-1 psql -U carga -d dispatch_carga -Atc $consulta) | ConvertFrom-Json
"$consulta`n$($correccion | ConvertTo-Json)" | Set-Content -LiteralPath (Join-Path $salida 'correccion.txt') -Encoding UTF8
$correccion.PSObject.Properties | ForEach-Object { Write-Output "  $($_.Name): $($_.Value)" }

[ordered]@{
  corrida         = $Corrida
  calentamiento_s = $CalentamientoS
  etapa_s         = $SegundosEtapa
  transicion_s    = $SegundosTransicion
  etapas          = $Etapas
  choferes_aptos  = $ChoferesAptos
  codigo_k6       = $codigoK6
  correccion      = $correccion
  commit          = (git rev-parse --short HEAD)
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $salida 'conteos.json') -Encoding UTF8

Paso "apagado de dispatch y location"
docker @compose stop dispatch location | Out-Null
docker logs viajes-carga-dispatch-1 2>&1 | Select-Object -Last 20 | Set-Content -LiteralPath (Join-Path $salida 'dispatch-log.txt') -Encoding UTF8
docker logs viajes-carga-location-1 2>&1 | Select-Object -Last 20 | Set-Content -LiteralPath (Join-Path $salida 'location-log.txt') -Encoding UTF8

Paso "listo: $salida"
Get-Content -LiteralPath (Join-Path $salida 'etapas-k6.json') -Raw | ConvertFrom-Json | ForEach-Object { $_.etapas } |
  Format-Table etapa, tasa, previstos_ventana_estable, iniciados_ventana_estable, omitidos_por_k6_etapa, asignados, sin_resolver, errores -AutoSize | Out-String -Width 200
