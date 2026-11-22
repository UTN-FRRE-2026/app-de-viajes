# Contenedor web (nginx)

El único punto de entrada (PLAN 2): sirve el frontend y hace de reverse proxy a los tres servicios. Archivos en `infra/web/`: la configuración (`default.conf`) y el `Dockerfile`, que también compila el frontend (`apps/web`, ver [El frontend](#el-frontend-appsweb)).

```
navegador ──▶ web :8080 ─┬─ /                → el frontend (index.html para cualquier ruta del frontend)
                         ├─ /api/identity/   → identity :3001
                         ├─ /api/viajes/     → dispatch :3005   (/api/viajes/eventos: SSE sin buffer)
                         └─ /api/ubicacion/  → location :3004
```

Se levanta con el resto: `docker compose up -d --build` y después http://localhost:8080 (`WEB_PUERTO` en el `.env`).

## El frontend (`apps/web`)

React + Vite + Zustand (PLAN 5.2), mínimo y sin PWA. Es un workspace más: `npm run dev:web` lo levanta en http://localhost:5173 con el mismo enrutamiento que nginx (el proxy de Vite manda `/api/identity`, `/api/viajes` y `/api/ubicacion` a 3001, 3005 y 3004), y `npm run build -w @viajes/web` lo compila. El `Dockerfile` de `web` lo compila en una etapa propia y nginx sirve `dist/`. Los archivos de `/assets/` llevan hash y se cachean para siempre; la página sigue con `no-cache` y la CSP.

**CSP.** El build no tiene scripts ni estilos en línea: un `index.html` mínimo, los estilos en archivos `.css` (nunca `style=`) y `assetsInlineLimit: 0`, para que nada quede embebido como `data:`. `npm run build` lo comprueba (`apps/web/scripts/revisar-csp.mjs`) y falla si encuentra código en línea.

**Sesión** (`src/sesion/store.ts`, Zustand):
- el access token vive **solo en memoria**; el `refreshToken` y el usuario se guardan en **`sessionStorage`**, que se pierde al cerrar la pestaña;
- al abrir la página, si quedó un refresh, se recupera la sesión **antes de redirigir**: mientras tanto el estado es `cargando` y ninguna ruta manda al login;
- **una sola renovación a la vez:** si varios pedidos reciben 401 juntos, comparten el mismo `POST /refresh`. Identity rota el refresh en cada uso y, si ve uno ya usado, revoca la sesión entera;
- el refresh **no se reintenta:** si no es válido, la sesión termina;
- al **cerrar sesión**, primero se limpia el estado (eso cambia la «época» de la sesión) y después se avisa a identity. Una renovación que vuelva después se descarta.

**Cliente HTTP** (`src/api/cliente.ts`):
- `pedir(metodo, '/viajes/solicitudes', { cuerpo, clave })` usa rutas relativas (`/api` + la ruta), agrega el `Authorization` y normaliza los errores en `ErrorApi`, con el formato `{error:{code,message,requestId}}` de los servicios. Si no hubo respuesta, el código es `RED`;
- con un **401**, una sola vez más: con el token vigente, si otro pedido ya lo renovó mientras este viajaba (un 401 que llegó tarde), o renovando. **El reintento conserva la misma `Idempotency-Key`.** Si igual da 401, la sesión termina;
- **`clave`:** las rutas que exigen `Idempotency-Key` son los POST y PUT con efecto de dispatch y `POST /identity/registro`. Se genera una por operación (`nuevaClave()`) y se reutiliza en cualquier reintento de esa misma operación. Los reintentos automáticos con espera y un `useOperacion()` para formularios se suman con el primer formulario que los necesite;
- **el login** va por su cuenta (`src/sesion/login.ts`): un 401 ahí es «email o contraseña incorrectos», no una sesión vencida. El 429 del límite de intentos muestra cuándo volver a probar.

**Errores.** `MensajeError` muestra el mensaje y el `requestId` (para buscarlo en el log), y ofrece «Reintentar» con red caída o 5xx. Un `ErrorBoundary` en el layout y el `errorElement` del router contienen las fallas al dibujar.

**Pantallas por rol.**

| Rol | Sección |
|---|---|
| `pasajero` | `/pasajero` |
| `chofer` | `/chofer` |
| `operador` y `admin` | `/operador` |
| `admin_flota` | `/flota` |

Cada rol tiene su archivo en `src/roles/` (`pasajero.tsx`, `chofer.tsx`, `operador.tsx`, `flota.tsx`), con `{ roles, base, titulo, menu, rutas }`. El router monta cada sección bajo su `base`, protegida por sus roles. Otro rol que entre por la URL ve «Esta pantalla no es para tu rol»; la autorización de verdad la hace la API. Después del login, cada uno va al inicio de su rol, o a la ruta de la que venía (`?volver=`, solo rutas internas).

Para sumar una pantalla:
1. el componente, en `src/roles/<rol>/`;
2. una entrada en `rutas` (relativa a `base`) y, si va en el menú, otra en `menu`, en el archivo del rol;
3. las llamadas con `pedir()`, pasando `clave` si la ruta exige Idempotency-Key.

Hoy cada rol tiene solo un inicio provisorio: las pantallas reales las suma su dueño (pasajero y operador, Iván; chofer, Maxi; admin de flota, Agos).

## Qué no se publica

`/interno/*` (de servicio a servicio, con token de servicio), `/metrics` (lo lee Alloy) y `/ready` (cuenta el estado de Postgres y Redis) responden **404** desde nginx, con el mismo formato de error que los servicios. Cualquier otro `/api/...` también es 404.

- Sin distinguir mayúsculas, porque Express tampoco las distingue: `/api/identity/INTERNO/...` no pasa.
- nginx compara contra la ruta ya decodificada y normalizada: `%69nterno`, `//interno` y `/./interno` tampoco pasan.
- `/health` y el JWKS (`/api/identity/.well-known/jwks.json`) sí se publican.

## La IP del cliente

nginx **reemplaza** `X-Forwarded-For` por la IP que ve (no le agrega): lo que mande el cliente no llega a los servicios. Cada servicio cree en ese encabezado **solo si viene de la IP de nginx** (`CONFIAR_EN_PROXY`, que el Compose arma con `WEB_IP`). Por eso:

- detrás de nginx, el límite de login por IP de identity cuenta por cliente, no por nginx;
- quien llegue directo al puerto de un servicio no puede inventarse otra IP para evadirlo: el encabezado se ignora.

nginx y los servicios comparten la red `proxy` (`WEB_RED`, por defecto `10.250.77.0/28`, fuera de los 172.x que Docker reparte), donde nginx tiene la IP fija `WEB_IP` (`10.250.77.10`). Si esa red choca con otra de la máquina, se cambian las dos variables en el `.env`.

`CONFIAR_EN_PROXY` acepta solo IP o redes en CIDR, separadas por coma. No acepta `true` ni rangos con nombre (`uniquelocal`), que serían confiar en cualquiera de la red. Sin la variable (`npm run dev`), no se confía en nadie.

Con Docker Desktop, todo lo que entra por un puerto publicado le llega a nginx con la IP del gateway de Docker: en la máquina de desarrollo, todos los clientes comparten esa IP. En un host Linux le llega la IP real del cliente.

## Encabezados de la página

- **CSP** (PLAN, Fase B): `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. Todo del mismo origen, sin scripts ni estilos en línea. Si se suma un mapa, su servidor de teselas va en `img-src`.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`.
- `Permissions-Policy`: geolocalización solo para la página (el chofer comparte su ubicación desde el navegador); cámara, micrófono y pagos, para nadie.
- `server_tokens off`: nginx no dice su versión.

Las respuestas de la API conservan los encabezados de cada servicio (helmet de `platform`, con su CSP `default-src 'none'`). Como el frontend y la API están en el mismo origen, no hace falta CORS.

## SSE

`/api/viajes/eventos` va sin buffer (`proxy_buffering off`, y dispatch manda además `X-Accel-Buffering: no`), así cada evento sale apenas llega. `proxy_read_timeout` es de 60 s, mayor que el latido de 15 s: nginx no corta la conexión por inactividad. Ver [docs/eventos.md](eventos.md).

## Otros detalles

- Los servicios se resuelven con el DNS de Docker en cada pedido (caché de 10 s): nginx arranca aunque alguno todavía no esté, y sigue a un contenedor que se recreó con otra IP. Si un servicio no está, ese prefijo responde 502.
- `X-Request-Id`: nginx manda el suyo y `platform` lo usa como `requestId`, así el mismo pedido se puede seguir en el log de nginx y en el del servicio.
- Imagen `nginxinc/nginx-unprivileged`: nginx corre sin root, en el puerto 8080.
- Los puertos de los servicios (3001, 3004 y 3005) se publican solo para desarrollo. En el entorno publicado para el ataque cruzado, solo se publica el de `web`.

## Probarlo

Con el Compose levantado:

```
npm run web:probar
```

Revisa la CSP y los encabezados de la página, que no haya scripts ni estilos en línea, que la API llegue a los tres servicios, que lo interno responda 404 (también con mayúsculas, codificado y con barras dobles) y que el SSE pase sin buffer. Para el SSE entra como el pasajero del seed, con `IDENTITY_SEED_CONTRASENA` del `.env`.

Probado el 22/11 contra el Compose: las 27 comprobaciones dan bien. Además, el límite de login de identity registró la IP del cliente que vio nginx, no la de nginx ni un `X-Forwarded-For` inventado; directo al puerto 3001, el inventado se ignoró.

El test automático de la IP está en identity (`tests/seguridad/limite-login.test.ts`, «detrás de nginx»): con `CONFIAR_EN_PROXY`, dos clientes detrás del mismo proxy cuentan por separado; la variable no acepta valores que confíen en cualquiera.

## Pendiente

- **Playwright:** la página carga sin violaciones de CSP en la consola (PLAN, Fase B).
- **TLS y HSTS** en el entorno publicado.
- **Límite de tasa** en solicitudes y ubicaciones (PLAN, B5): en los servicios, que ya ven la IP del cliente.
