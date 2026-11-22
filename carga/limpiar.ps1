# Vacía los datos de carga: la tabla pings de location_carga y las claves carga:location:* de Redis
# y, si existe, la base dispatch_carga (la solicitud real) con sus claves dispatch:* de Redis.
# SOLO en el entorno aislado de carga. Antes de borrar nada comprueba, con las etiquetas de Docker,
# que los contenedores son del proyecto viajes-carga, y se NIEGA a correr si algo apunta al entorno
# habitual (proyecto app-viajes, base location, prefijo location:, puertos 5434 o 6379).
param(
  [string]$Proyecto = 'viajes-carga',
  [string]$Base = 'location_carga',
  [string]$Prefijo = 'carga:location:'
)

# 'Continue' y no 'Stop': en PowerShell 5.1, con 'Stop', cualquier línea que un programa externo
# escriba en stderr corta el script. Cada paso revisa $LASTEXITCODE.
$ErrorActionPreference = 'Continue'

function Negarse([string]$motivo) {
  [Console]::Error.WriteLine("limpiar.ps1: me niego a limpiar. $motivo")
  exit 2
}

if ($Proyecto -ne 'viajes-carga') { Negarse "El proyecto tiene que ser viajes-carga, no '$Proyecto'." }
if ($Base -ne 'location_carga') { Negarse "La base tiene que ser location_carga, no '$Base'." }
if ($Prefijo -ne 'carga:location:') { Negarse "El prefijo tiene que ser carga:location:, no '$Prefijo'." }

function Contenedor([string]$servicio) {
  $nombres = @(docker ps --filter "label=com.docker.compose.project=$Proyecto" --filter "label=com.docker.compose.service=$servicio" --format '{{.Names}}')
  if ($nombres.Count -ne 1 -or -not $nombres[0]) { Negarse "No encuentro exactamente un contenedor '$servicio' del proyecto $Proyecto." }
  $nombre = $nombres[0]
  # Las etiquetas como JSON: PowerShell 5.1 pierde las comillas internas de una plantilla con index.
  $etiquetas = docker inspect $nombre --format '{{json .Config.Labels}}' | ConvertFrom-Json
  $proyectoReal = $etiquetas.'com.docker.compose.project'
  $entorno = $etiquetas.'app-viajes.entorno'
  if ($proyectoReal -ne $Proyecto -or $entorno -ne 'carga') {
    Negarse "El contenedor $nombre no tiene las etiquetas del entorno de carga (proyecto '$proyectoReal', entorno '$entorno')."
  }
  $puertos = docker port $nombre 2>$null | Out-String
  if ($puertos -match ':(5434|6379|3004|3001|3005)\b') { Negarse "El contenedor $nombre publica un puerto del entorno habitual." }
  return $nombre
}

$postgres = Contenedor 'postgres'
$redis = Contenedor 'redis'

# Postgres de carga: solo la base location_carga. Si la tabla todavía no existe (antes de migrar), no hay nada que vaciar.
docker exec $postgres psql -U carga -d $Base -v ON_ERROR_STOP=1 -qc "DO `$`$ BEGIN IF to_regclass('public.pings') IS NOT NULL THEN TRUNCATE pings; END IF; END `$`$;"
if ($LASTEXITCODE -ne 0) { Write-Error 'limpiar.ps1: no se pudo vaciar pings.'; exit 1 }

# Redis de carga: solo las claves con el prefijo de carga.
$borradas = docker exec $redis sh -c "redis-cli --scan --pattern '$($Prefijo)*' | xargs -r redis-cli del | awk '{s+=`$1} END {print s+0}'"
if ($LASTEXITCODE -ne 0) { Write-Error 'limpiar.ps1: no se pudieron borrar las claves de carga.'; exit 1 }

# dispatch de carga (medir.ps1 -Solicitudes): la base dispatch_carga, si existe, y sus claves dispatch:*
# en el MISMO Redis de carga, ya verificado arriba por sus etiquetas.
$hayDispatch = (docker exec $postgres psql -U carga -d $Base -Atc "SELECT 1 FROM pg_database WHERE datname = 'dispatch_carga'") -eq '1'
if ($hayDispatch) {
  docker exec $postgres psql -U carga -d dispatch_carga -v ON_ERROR_STOP=1 -qc "DO `$`$ BEGIN IF to_regclass('public.ride_requests') IS NOT NULL THEN TRUNCATE outbox, driver_active_assignment, offers, payments, ride_requests, idempotency_keys, drivers, fleets; END IF; END `$`$;"
  if ($LASTEXITCODE -ne 0) { Write-Error 'limpiar.ps1: no se pudo vaciar dispatch_carga.'; exit 1 }
  docker exec $redis sh -c "redis-cli --scan --pattern 'dispatch:*' | xargs -r redis-cli del" | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Error 'limpiar.ps1: no se pudieron borrar las claves de dispatch de carga.'; exit 1 }
}

Write-Output "limpiar.ps1: pings vaciada en $Base ($postgres); claves borradas en $redis con prefijo $($Prefijo): $borradas"
