# identity (M1): primer incremento

> **Estado: parcial.** Funcionan registro, login, JWT RS256, JWKS, seed y límite de intentos de login. M1 **no está terminado**: faltan refresh con rotación, logout y revocación. Ver [Pendiente](#pendiente).

## Endpoints

Base local: `http://localhost:3001`. Los errores usan el formato único `{error:{code,message,requestId}}`, y los esquemas viven en `packages/contracts/src/identity.ts`.

### `POST /registro`

Registro público. Solo crea `pasajero` y `chofer`.

```json
{ "email": "ana@ejemplo.com", "contrasena": "12 a 128 caracteres", "nombre": "Ana", "rol": "pasajero" }
```

| Respuesta | Cuándo |
|---|---|
| `201 {id, email, nombre, rol, creadoEn}` | Registrado. No devuelve el hash ni un token |
| `400 VALIDACION` | Falta un campo, hay una clave no declarada (`fleetId`, `__proto__`…) o el rol es `admin`, `operador` o `admin_flota` |
| `409 IDENTIFICADOR_EN_USO` | El email ya existe, sin distinguir mayúsculas |

- El **identificador de acceso es el email**, en minúsculas y sin espacios alrededor.
- El registro público no admite roles privilegiados en dos capas: el esquema `strictObject` y la entidad `Usuario` (`ROL_NO_REGISTRABLE`, por si otro adaptador llamara al caso de uso).
- La unicidad la decide el índice único de Postgres, también con pedidos simultáneos.

### `POST /login`

```json
{ "email": "ana@ejemplo.com", "contrasena": "..." }
```

| Respuesta | Cuándo |
|---|---|
| `200 {token, tipo:"Bearer", expiraEnSegundos, usuario:{id,email,nombre,rol,fleetId?,creadoEn}}` | Credenciales correctas. Con `Cache-Control: no-store` |
| `400 VALIDACION` | Body inválido. No consume intentos |
| `401 CREDENCIALES_INVALIDAS` | Email inexistente o contraseña incorrecta: misma respuesta, y en el primer caso igual corre un argon2 señuelo |
| `429 DEMASIADOS_INTENTOS` | Se superó el límite. Con `Retry-After` |
| `503 LIMITE_NO_DISPONIBLE` | Redis no responde: **falla cerrado**, no se verifica ninguna contraseña |

Toda respuesta que pasó por el contador trae `RateLimit-Limit`, `RateLimit-Remaining` y `RateLimit-Reset`.

### `GET /.well-known/jwks.json`

`{"keys":[{"kty":"RSA","n":"...","e":"AQAB","kid":"...","alg":"RS256","use":"sig"}]}` con `Cache-Control: public, max-age=300`. Solo la parte pública. Dispatch lo consume con `verificadorJwks`.

### `GET /health` y `GET /ready`

Los de `platform`. `/ready` responde 503 si falla Postgres, si hay migraciones pendientes o si no responde Redis.

## Token

JWT firmado con RS256. Encabezado `{alg, kid, typ}`, donde `kid` es el thumbprint RFC 7638 de la clave.

| Claim | Valor |
|---|---|
| `sub` | UUID del usuario (dispatch lo usa como `pasajeroId` o `choferId`) |
| `rol` | `pasajero`, `chofer`, `operador`, `admin` o `admin_flota` |
| `fleetId` | Solo en `admin_flota` |
| `iss`, `aud` | `JWT_ISSUER` y `JWT_AUDIENCE`, las mismas variables que usa dispatch |
| `iat`, `exp` | 15 minutos de vida (`JWT_TTL_SEGUNDOS`) |
| `jti` | UUID. Queda listo para la denylist de revocación, que todavía no existe |

Es el contrato de `packages/platform/src/autenticacion.ts`, que no se modificó. Como no hay refresh, al vencer hay que volver a hacer login.

## Contraseñas

argon2id con **m = 19456 KiB (19 MiB), t = 2, p = 1**, el mínimo que recomienda OWASP. Se configuran con `ARGON2_MEMORIA_KIB`, `ARGON2_ITERACIONES` y `ARGON2_PARALELISMO`: se pueden subir, pero `config` no acepta valores por debajo de ese piso. Los parámetros quedan guardados en cada hash (formato PHC) y la verificación usa los del hash.

## Límite de intentos de login

Vive en identity porque todavía no hay gateway. Corre después de validar el body y **antes de argon2**, con un script Lua que incrementa y fija el vencimiento de forma atómica en Redis.

| Contador | Máximo | Variable |
|---|---|---|
| Por email (guardado como SHA-256, sin datos personales en Redis) | 5 | `IDENTITY_LOGIN_MAX_POR_EMAIL` |
| Por IP | 30 | `IDENTITY_LOGIN_MAX_POR_IP` |
| Ventana fija | 900 s | `IDENTITY_LOGIN_VENTANA_SEGUNDOS` |

- Un login correcto borra el contador del email. El de la IP sigue corriendo, así que también cuenta los logins correctos.
- Mientras un email está bloqueado, ni la contraseña correcta entra.
- **Riesgo aceptado:** un tercero puede bloquear una cuenta ajena durante 15 minutos. Es el costo de frenar ataques que cambian de IP.
- `req.ip` no lee `X-Forwarded-For`, así que ese header no permite evadir el límite. Cuando exista el gateway habrá que configurar `trust proxy` (ver [Pendiente](#pendiente)).

## Usuarios de prueba

`npm run local -- identity seed` carga uno por rol. Es idempotente, usa UUID fijos y se niega a correr con `NODE_ENV=production`. La contraseña es `IDENTITY_SEED_CONTRASENA` del `.env`, solo para desarrollo.

| Email | Rol | id |
|---|---|---|
| `pasajero@viajes.test` | `pasajero` | `00000000-0000-4000-8000-000000000001` |
| `chofer@viajes.test` | `chofer` | `00000000-0000-4000-8000-000000000002` |
| `operador@viajes.test` | `operador` | `00000000-0000-4000-8000-000000000003` |
| `admin@viajes.test` | `admin` | `00000000-0000-4000-8000-000000000004` |
| `admin.flota@viajes.test` | `admin_flota` (fleetId `00000000-0000-4000-8000-0000000000f1`) | `00000000-0000-4000-8000-000000000005` |

## Levantarlo desde PowerShell

Requisitos: Node 22 o superior, Docker Desktop con el motor en marcha. Todos los comandos van desde la raíz del repo.

### Primera vez

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm ci
npm run infra:up
npm run claves -w @viajes/identity
npm run prisma:generate --workspaces --if-present
npm run local -- identity migrate:deploy
npm run local -- dispatch migrate:deploy
npm run local -- identity seed
```

- Si ya tenías un `.env`, agregale las variables nuevas de la sección `identity` de `.env.example`: copiar no lo reemplaza.
- `npm run claves` agrega la clave privada al `.env` sin mostrarla, y no toca una clave que ya exista.
- Para probar el flujo completo, `DISPATCH_CANDIDATOS_DEMO` tiene que tener el id del chofer de prueba, como en `.env.example`.

### Correr los servicios

Cada uno en su propia terminal:

```powershell
npm run local -- identity
```

```powershell
npm run local -- dispatch
```

`npm run local` abre un proceso aparte que carga `.env` y fija `PUERTO`: **identity siempre en 3001 y dispatch siempre en 3005**, aunque la terminal tenga otro `PUERTO`. Nada queda cargado en la sesión. Ctrl+C los detiene. Usá siempre esta forma: si ejecutás `.\scripts\local.ps1` directamente, las variables quedan en tu terminal.

## Probar el login y el acceso a dispatch

En una tercera terminal, desde la raíz del repo. Los bloques comparten variables, así que van en orden y en la misma terminal.

**1. Preparar y comprobar que están listos**

```powershell
$identity = 'http://localhost:3001'
$dispatch = 'http://localhost:3005'
$contrasena = (Select-String -Path .env -Pattern '^IDENTITY_SEED_CONTRASENA=(.*)$').Matches[0].Groups[1].Value
function Entrar($email) {
  $body = @{ email = $email; contrasena = $contrasena } | ConvertTo-Json
  Invoke-RestMethod -Method Post "$identity/login" -ContentType 'application/json' -Body $body
}
Invoke-RestMethod "$identity/ready" | ConvertTo-Json -Compress
Invoke-RestMethod "$dispatch/ready" | ConvertTo-Json -Compress
```

Esperado: `"estado":"listo"` en los dos.

**2. Ver la clave pública**

```powershell
Invoke-RestMethod "$identity/.well-known/jwks.json" | Select-Object -ExpandProperty keys | Select-Object kty, alg, use, kid
```

**3. Login del pasajero y pedido de viaje a dispatch**

```powershell
$pasajero = Entrar 'pasajero@viajes.test'
$conPasajero = @{ Authorization = "Bearer $($pasajero.token)" }
$viaje = @{ origen = @{ lat = -34.6037; lng = -58.3816 }; destino = @{ lat = -34.5875; lng = -58.4207 } } | ConvertTo-Json
$solicitud = Invoke-RestMethod -Method Post "$dispatch/solicitudes" -ContentType 'application/json' -Headers $conPasajero -Body $viaje
$solicitud | Select-Object id, estado, pasajeroId
```

Esperado: `estado` en `BUSCANDO` y `pasajeroId` igual al `sub` del token. Dispatch verificó la firma con el JWKS de identity.

**4. Login del chofer y aceptación de la oferta**

Todavía no hay un endpoint para listar ofertas, así que el id se lee de la base.

```powershell
$oferta = docker compose exec -T postgres psql -U postgres -d dispatch -Atc "SELECT id FROM offers WHERE request_id = '$($solicitud.id)'"
$chofer = Entrar 'chofer@viajes.test'
$conChofer = @{ Authorization = "Bearer $($chofer.token)" }
Invoke-RestMethod -Method Post "$dispatch/ofertas/$oferta/aceptar" -ContentType 'application/json' -Headers $conChofer -Body '{}' | Select-Object estado, choferId
```

Esperado: `estado` en `ASIGNADO`.

**5. Ver el `fleetId` del admin de flota**

```powershell
$flota = Entrar 'admin.flota@viajes.test'
$carga = $flota.token.Split('.')[1].Replace('-', '+').Replace('_', '/')
$carga += '=' * ((4 - $carga.Length % 4) % 4)
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($carga)) | ConvertFrom-Json | Select-Object sub, rol, fleetId, iss, aud
```

**6. Comprobar los rechazos**

```powershell
function Estado([scriptblock]$pedido) {
  try { & $pedido | Out-Null; 'HTTP 2xx' } catch { "HTTP $([int]$_.Exception.Response.StatusCode)" }
}
# Un chofer no puede pedir viajes: 403
Estado { Invoke-RestMethod -Method Post "$dispatch/solicitudes" -ContentType 'application/json' -Headers $conChofer -Body $viaje }
# Sin token: 401
Estado { Invoke-RestMethod -Method Post "$dispatch/solicitudes" -ContentType 'application/json' -Body $viaje }
# Registrar un admin: 400
$admin = @{ email = 'colado@viajes.test'; contrasena = 'una-contrasena-larga'; nombre = 'X'; rol = 'admin' } | ConvertTo-Json
Estado { Invoke-RestMethod -Method Post "$identity/registro" -ContentType 'application/json' -Body $admin }
```

**7. Probar el límite de intentos**

Cinco veces 401 y la sexta 429:

```powershell
$malo = @{ email = 'operador@viajes.test'; contrasena = 'esta-no-es' } | ConvertTo-Json
1..6 | ForEach-Object { Estado { Invoke-RestMethod -Method Post "$identity/login" -ContentType 'application/json' -Body $malo } }
```

Ese email queda bloqueado 15 minutos. Para seguir probando antes de que venza, vaciá los contadores:

```powershell
docker compose exec -T redis redis-cli --scan --pattern 'identity:login:*' | ForEach-Object { docker compose exec -T redis redis-cli del $_ | Out-Null }
```

**8. Cancelar el viaje para poder repetir la prueba**

Cada pasajero admite una sola solicitud activa, y el chofer queda ocupado hasta que se libera.

```powershell
Invoke-RestMethod -Method Post "$dispatch/solicitudes/$($solicitud.id)/cancelar" -ContentType 'application/json' -Headers $conPasajero -Body '{}' | Select-Object estado
```

## Tests

```powershell
npm test -w @viajes/identity
npm run test:dominio -w @viajes/identity
npm run lint
npm run typecheck
```

- `test:dominio` no necesita Docker.
- `npm test` necesita Postgres y Redis (`npm run infra:up`). Usa la base `identity_test` y la base 15 de Redis, que vacía en cada test.
- El test de compatibilidad lanza el **dispatch real** en un proceso aparte y le hace bajar las claves por HTTP.

## Problemas frecuentes

**Postgres no arranca y el log dice `bad interpreter: ^M`.** El script de init quedó con finales CRLF. `.gitattributes` ya lo evita en los clones nuevos. Si el volumen se creó con ese error, quedó sin bases: después de actualizar el repo, con el contenedor en marcha, ejecutá el script una vez:

```powershell
docker compose up -d postgres
docker compose exec -T -e POSTGRES_USER=postgres postgres bash /docker-entrypoint-initdb.d/01-bases-por-servicio.sh
```

**Falta la base `identity_test`.** El script de init solo corre con el volumen vacío. Si Postgres ya estaba inicializado, creala a mano. Si ya existe, el comando avisa y no cambia nada:

```powershell
docker compose exec -T postgres psql -U postgres -c "CREATE DATABASE identity_test OWNER identity_svc"
docker compose exec -T postgres psql -U postgres -c "REVOKE ALL ON DATABASE identity_test FROM PUBLIC"
```

**`/ready` dice `migraciones pendientes`.** Falta `npm run local -- identity migrate:deploy`.

**El servicio sale con `[config] variable ...`.** Falta o está mal esa variable. Si es la clave privada, corré `npm run claves -w @viajes/identity`.

## Pendiente

Este incremento **no** incluye:

- **Refresh token con rotación.**
- **Logout.**
- **Revocación:** denylist de `jti` en Redis que falla cerrado. Hasta entonces, un token robado vale hasta que vence, como máximo 15 minutos.
- `trust proxy` cuando exista el gateway. Sin eso, todos los pedidos que pasen por el gateway compartirían el contador de IP.
- Límite de pedidos en `/registro`: hoy cada registro cuesta un argon2 y no tiene freno.
- Rotación de claves: el JWKS publica una sola clave.
- Rehash de contraseñas si se suben los parámetros de argon2.
- Eventos de identity (no existe la mensajería en `platform`).
- OpenAPI y ADR 3 (JWT).

`docker-compose.yml` ya define el servicio `identity`, pero el contenedor no aplica migraciones: igual que en dispatch, hay que correrlas desde el host.
