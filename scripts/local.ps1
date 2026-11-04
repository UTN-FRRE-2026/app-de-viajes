# Corre un script npm de un servicio con las variables de .env y SU puerto.
#
#   npm run local -- identity                 (por defecto: dev)
#   npm run local -- identity migrate:deploy
#
# `npm run local` abre un proceso de PowerShell aparte: lo que se carga aca muere con el, asi
# que no queda nada en la terminal. PUERTO se fija siempre por servicio y pisa cualquier valor
# heredado, entonces identity y dispatch no se pueden afectar entre si.
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('identity', 'dispatch')]
  [string]$Servicio,

  [Parameter(Position = 1)]
  [string]$Script = 'dev'
)

$ErrorActionPreference = 'Stop'

$puertos = @{ identity = 3001; dispatch = 3005 }
$raiz = Split-Path -Parent $PSScriptRoot
$rutaEnv = Join-Path $raiz '.env'

if (-not (Test-Path -LiteralPath $rutaEnv)) {
  Write-Error 'No existe .env en la raiz del repo. Copia .env.example a .env.'
}

foreach ($linea in Get-Content -LiteralPath $rutaEnv -Encoding UTF8) {
  if ($linea -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
  }
}
$env:PUERTO = [string]$puertos[$Servicio]

Set-Location -LiteralPath $raiz
& npm run $Script -w "@viajes/$Servicio"
exit $LASTEXITCODE
