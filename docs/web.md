# Contenedor web (nginx)

El único punto de entrada (PLAN 2): sirve el frontend y hace de reverse proxy a los tres servicios. Archivos en `infra/web/`: la configuración (`default.conf`), el `Dockerfile` y, mientras no esté el frontend, una página provisoria (`sitio/`).

```
navegador ──▶ web :8080 ─┬─ /                → el frontend (index.html para cualquier ruta del frontend)
                         ├─ /api/identity/   → identity :3001
                         ├─ /api/viajes/     → dispatch :3005   (/api/viajes/eventos: SSE sin buffer)
                         └─ /api/ubicacion/  → location :3004
```

Se levanta con el resto: `docker compose up -d --build` y después http://localhost:8080 (`WEB_PUERTO` en el `.env`).

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

- **El frontend:** una etapa en el `Dockerfile` que lo compile con Vite y copie su `dist/` en lugar de `sitio/`, y caché larga para los archivos con hash.
- **Playwright:** la página carga sin violaciones de CSP en la consola (PLAN, Fase B).
- **TLS y HSTS** en el entorno publicado.
- **Límite de tasa** en solicitudes y ubicaciones (PLAN, B5): en los servicios, que ya ven la IP del cliente.
