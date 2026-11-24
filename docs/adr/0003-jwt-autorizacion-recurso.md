# ADR 0003 — JWT RS256 emitido por identity y verificado por JWKS; la autorización por recurso, en el caso de uso

- **Estado:** aceptado
- **Fecha:** 2026-11-24. Registra lo que ya está en `main`: identity con RS256, JWKS y refresh desde el 2026-11-04 (migraciones `inicial` y `refresh_tokens`), logout (#5), la verificación por JWKS en location (#7) y el token de servicio de las rutas internas.
- **Quiénes participaron:** Agos (dueña de identity y del ADR en el reparto) y Maxi (logout y revocación, #5). Redacción: Ivan. Revisión: pendiente (Agos y Maxi).
- **Servicios:** identity emite; dispatch y location verifican; el verificador y el token de servicio, en `platform` — B5 (autenticación y autorización por recurso)

## Contexto

Hay cinco roles (`pasajero`, `chofer`, `operador`, `admin`, `admin_flota`) y tres servicios. En cada pedido, dispatch y location tienen que saber quién llama y con qué rol, sin preguntarle a identity cada vez ([PLAN.md](../../PLAN.md) §2).

Saber el rol no alcanza. Cada recurso tiene dueño:

- un viaje es de su pasajero y de su chofer;
- un chofer es de una flota, y solo el `admin_flota` de esa flota lo administra;
- una posición es del chofer que la informa.

Además, los servicios se llaman entre sí por rutas `/interno/*` que no son para clientes. B5 pide argon2id con costo declarado, refresh con rotación y detección de reuso, y autorización por recurso con test.

## Opciones consideradas

**Cómo sabe cada servicio quién llama:**

| Opción | Por qué no / por qué sí |
|---|---|
| **Sesión con cookie** (id opaco y estado en el servidor) | dispatch y location tendrían que consultar la sesión en cada pedido: llamando a identity o compartiendo su almacén. La cookie viaja sola, así que hace falta defensa contra CSRF. A favor: el logout corta al instante |
| **JWT HS256 con un secreto compartido** | Quien verifica también puede firmar: un dispatch o un location comprometido emitiría un token de `admin`. Y el secreto tiene que estar en los tres servicios |
| **OAuth 2.0 / OIDC con un proveedor externo** (Keycloak, Auth0) | Otro componente para operar, o una dependencia externa. El registro, el login, los roles y el `fleetId` se configurarían ahí, y lo que pide B5 (argon2id, rotación, reuso) no estaría en nuestro código |
| **Un gateway que autoriza** | El plan v2 lo descarta: nginx es el punto de entrada y no verifica tokens. Y un gateway decide por rol, no por recurso: para saber si un viaje es del pasajero hay que leer el viaje, que está en la base de dispatch |
| **JWT RS256 firmado por identity, verificado con su JWKS** | La elegida: solo identity tiene la clave privada, y los demás verifican sin llamarlo |

**Dónde se decide el acceso a un recurso:**

| Opción | Por qué no / por qué sí |
|---|---|
| En un middleware de la ruta | Solo tiene el token y la URL. Para comparar dueños tendría que leer el recurso, y lo leería dos veces |
| **En el caso de uso** | La elegida: ya tiene el recurso en la mano, y la regla vale para cualquier adaptador (HTTP, tests de dominio) |

**Entre servicios:** un JWT de servicio emitido por identity sumaba un rol nuevo y cambios en identity, sin una ganancia que hoy haga falta ([docs/location.md](../location.md#contrato-con-dispatch)). Quedó un secreto compartido por ruta.

## Decisión

**El access token.** identity firma con RS256. La clave privada es RSA de 2048 bits o más (`IDENTITY_JWT_CLAVE_PRIVADA_B64`); `config` rechaza una más corta y no repite el valor. Claims ([docs/identity.md](../identity.md#token)):

- `sub` (el id del usuario), `rol`, y `fleetId` solo en `admin_flota`;
- `iss`, `aud`, `iat`, `exp` y `jti`;
- en el encabezado, `kid`: el thumbprint RFC 7638 de la clave.

Vive `JWT_TTL_SEGUNDOS`: 15 minutos por defecto, entre 60 y 3600 s. identity publica la parte pública en `GET /.well-known/jwks.json`.

**La verificación** (`packages/platform/src/autenticacion.ts`). dispatch y location usan `verificadorJwks`: el `createRemoteJWKSet` de `jose` baja y cachea las claves. Se exige `RS256`, el `iss` y la `aud` configurados, un `sub` y un rol de la lista. Si algo falla: 401 `NO_AUTENTICADO`. Después, `requerirRol(...)` en la ruta: 403 `ROL_NO_PERMITIDO`.

**La sesión** (detalle en [docs/identity.md](../identity.md#post-refresh)):

- **Refresh opaco** de 32 bytes; en `refresh_tokens` se guarda solo su SHA-256.
- **Una familia por login.** Cada uso rota el token: `UPDATE … WHERE used_at IS NULL` en la misma transacción que crea el siguiente.
- **Reuso:** un refresh ya usado revoca la familia entera. La rotación y la revocación toman antes un advisory lock por familia.
- El refresh vive 7 días y se renueva en cada rotación. El access nuevo toma el rol y el `fleetId` **actuales**.
- **Logout** revoca la familia. El access token ya emitido vale hasta su `exp`: el plan v2 descarta la denylist de `jti`.

**Las contraseñas.** argon2id con m = 19 456 KiB, t = 2, p = 1, el piso de OWASP; `config` no acepta menos. Un email inexistente igual corre un argon2 señuelo. El límite de intentos de login (5 por email y 30 por IP cada 15 min) corre **antes** de argon2 y falla cerrado.

**Entre servicios** (`packages/platform/src/token-servicio.ts`). Cada ruta interna exige `X-Token-Servicio` con su propio secreto, de al menos 32 caracteres:

| Ruta | Secreto |
|---|---|
| location `GET /interno/candidatos` | `LOCATION_TOKEN_SERVICIO` |
| identity `GET /interno/usuarios/:id` | `IDENTITY_TOKEN_SERVICIO` |
| dispatch `POST /interno/tramos-viaje` | `DISPATCH_TOKEN_SERVICIO` |

`exigirTokenServicio` compara las huellas SHA-256 en tiempo constante, responde siempre el mismo 401 `TOKEN_SERVICIO_INVALIDO` y nunca loguea el valor. El JWT de un usuario no abre estas rutas, y el token de servicio no abre las de usuarios. nginx no publica `/interno/*` (`infra/web/default.conf`).

**La autorización por recurso, en el caso de uso:**

- **El usuario sale del token**, nunca del cuerpo: los esquemas son estrictos, y un `choferId` o un `fleetId` en el cuerpo dan 400.
- **Viajes:** leer un viaje ajeno da 404 `SOLICITUD_NO_ENCONTRADA`, salvo para operador y admin (`obtener-solicitud.ts`). Cancelar: el pasajero, solo la suya; el chofer, solo la que tiene asignada; si no, el mismo 404 (`cancelar-solicitud.ts`). La oferta de otro chofer: 404 `OFERTA_NO_ENCONTRADA` (`aceptar-oferta.ts`).
- **Flotas:** el `fleetId` sale del token (`flotaDelActor`). Un chofer de otra flota responde 404 `CHOFER_NO_ENCONTRADO`, igual que uno que no existe (`exigirMismaFlota`, `src/dominio/flotas/chofer.ts`). Sin `fleetId`: 403 `FLOTA_NO_ASIGNADA`. Una flota que dispatch no conoce: 404 `FLOTA_NO_ENCONTRADA`.
- **Tiempo real y posiciones:** cada uno recibe solo lo suyo ([ADR 0007](0007-tiempo-real-sse.md)). En location, la posición se guarda a nombre del `sub`.
- **404 y no 403:** así no se revela que el recurso existe.

## Consecuencias

- dispatch y location verifican sin llamar a identity. Si identity se cae, siguen verificando con las claves que ya bajaron, mientras sigan en la caché de `jose`.
- La clave privada está solo en identity: comprometer otro servicio no permite emitir tokens.
- **El access token no se puede revocar.** Vale hasta 15 minutos después del logout o de detectar un reuso. Un cambio de rol o de flota se aplica en el próximo refresh. La alternativa sin código es bajar `JWT_TTL_SEGUNDOS`.
- **Una sola clave en el JWKS:** no hay rotación. Cambiarla hace que los access tokens vigentes den 401 hasta que el cliente renueve.
- **Dos refresh en paralelo con el mismo token cierran la sesión.** El cliente tiene que serializarlos: la web hace uno solo a la vez (`apps/web/src/api/cliente.ts`).
- **La web guarda** el access token en memoria y el refresh en `sessionStorage` (`apps/web/src/sesion/store.ts`): sobrevive a una recarga y se pierde al cerrar la pestaña. Un script inyectado podría leerlo: la defensa es la CSP de la página ([docs/web.md](../web.md)).
- **Cada caso de uso nuevo con un recurso tiene que comparar al dueño.** Nada lo fuerza: lo cubren la revisión del PR y un test de acceso ajeno por módulo.
- **Los secretos de servicio son compartidos:** identifican la ruta, no a quién llama. Cambiar uno es cambiar la variable en los dos servicios.
- `refresh_tokens` no se limpia nunca, y una sesión que se usa seguido no vence: pendientes en [docs/identity.md](../identity.md#pendiente).
- Riesgo aceptado del límite por email: un tercero puede bloquear una cuenta ajena 15 minutos.

## Cómo se verifica

- identity, `tests/integracion/compatibilidad-dispatch.test.ts`: levanta el dispatch real, que baja el JWKS real. Acepta el token de identity y lee el `fleetId`. Rechaza (401) sin token, un payload alterado, otro `iss`, otra `aud`, un token vencido, otra clave con el `kid` de identity y `alg: none`. Y comprueba que el access token sigue valiendo después del logout.
- identity, `tests/dominio/emisor-jwt.test.ts` (claims, `kid`, solo campos públicos en el JWKS) y `tests/dominio/config.test.ts` (rechaza una clave RSA de menos de 2048 bits; sin configurar, arranca con los parámetros de OWASP).
- identity, `tests/integracion/refresh.test.ts`, `tests/concurrencia/registro-y-login.test.ts` (20 refresh simultáneos: 1 rota y la familia queda revocada; reuso durante una rotación) y `tests/concurrencia/logout.test.ts`.
- Rutas internas: identity `tests/seguridad/interno.test.ts`; location `tests/seguridad/http.test.ts` (el JWT de un usuario no abre `/interno/candidatos`; el token de servicio no sirve para informar una posición; `choferId` en el cuerpo da 400).
- dispatch, `tests/seguridad/http.test.ts`: sin token y con otra clave, 401; roles, 403; recursos ajenos (leer, cancelar, aceptar la oferta de otro), 404 sin cambios; el historial sale del token.
- dispatch, `tests/integracion/flotas.test.ts` (aislamiento: el 404 de otra flota es idéntico al de un chofer inexistente) y `tests/seguridad/flotas.test.ts` (sin `fleetId`, 403; flota desconocida, 404).

Desde afuera, los ataques de autenticación y recursos ajenos están en [docs/ataque.md](../ataque.md).

## Qué nos haría cambiar de decisión

- **Necesitar cortar un access token al instante** (una cuenta robada, un chofer dado de baja). Se agrega una denylist de `jti` en Redis, consultada por `autenticar` en `platform` y fallando cerrado si Redis no responde. Cambia los tres servicios, no solo identity.
- **Rotar la clave sin cortar a nadie.** El JWKS pasa a publicar dos claves durante la transición; los verificadores ya eligen por `kid`.
- **Más servicios internos o llamadas cruzadas.** Con muchos pares, un secreto por ruta no escala: un token de servicio firmado por identity, con su `aud`, identificaría a quién llama.
- **Un cliente de terceros** que actúe en nombre de un usuario. Ahí OAuth 2.0 / OIDC tiene sentido.
