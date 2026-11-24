# Despliegue del entorno publicado

El entorno que atacan los otros grupos (ataque cruzado, [ataque.md](ataque.md)). A los grupos se les pasa **una URL**, los usuarios de prueba y la contraseña de esos usuarios. Nada más: ni puertos de servicios, ni `/metrics`, ni la base.

## Qué queda publicado

```mermaid
flowchart LR
  internet((Internet)) -->|80 / 443| caddy[Caddy<br/>TLS y HSTS]
  caddy -->|X-Forwarded-For| web[nginx<br/>frontend y /api]
  web --> identity & dispatch & location
  identity & dispatch & location --> pg[(Postgres)] & redis[(Redis)]
```

| | Desarrollo (`docker-compose.yml`) | Publicado (`+ deploy/compose.produccion.yml`) |
|---|---|---|
| Puertos abiertos | 8080 (nginx), 3001, 3004, 3005, 5434, 6379 | **80 y 443 (Caddy)**. Postgres solo en `127.0.0.1` (migraciones y seed desde la máquina) |
| TLS | No | Caddy, con certificado de Let's Encrypt automático, y HSTS |
| Secretos | Los de `.env.example` (`*_dev`, `solo-desarrollo-*`) | Generados al azar en `deploy/.env.produccion` (no se versiona) |
| location | `ingenua` | `optimizada` (aguanta 500 choferes, [mediciones.md](mediciones.md)) |
| Reinicio | No | `restart: unless-stopped`: vuelve solo si se reinicia la máquina |

La IP del cliente llega hasta los servicios en dos saltos: Caddy pone `X-Forwarded-For`, nginx lo cree **solo** si viene de la IP fija de Caddy (`set_real_ip_from ${CADDY_IP}`, por defecto `10.250.77.11`), y los servicios lo creen solo si viene de la IP fija de nginx (`CONFIAR_EN_PROXY`). Así los límites de login por IP cuentan por cliente, y nadie puede inventarse otra IP desde afuera.

`/interno/*`, `/metrics` y `/ready` no se publican (nginx da 404). Los límites de tasa están activos ([seguridad.md](seguridad.md#límite-de-tasa)).

## Requisitos

- Una máquina Linux con Docker y **Compose 2.24 o más nuevo** (`docker compose version`), **Node 22** y Git. Con 2 CPU y 4 GB alcanza para la demo; para correr k6 contra el entorno, más.
- Puertos **80 y 443** abiertos hacia la máquina.
- **Un dominio** con un registro DNS `A` apuntando a la IP de la máquina (Caddy necesita el 80 para sacar el certificado). Sin dominio: `:80` (HTTP) detrás de un túnel que ponga el HTTPS (por ejemplo Cloudflare Tunnel), o detrás de la IP sola si la cátedra lo acepta.

## Levantarlo

Desde el tag congelado, en la máquina publicada:

```bash
git clone <repo> app-viajes && cd app-viajes
git checkout congelado          # o main, antes de congelar
npm ci
node deploy/desplegar.mjs viajes.midominio.com
```

[`deploy/desplegar.mjs`](../deploy/desplegar.mjs) hace todo, y se puede volver a correr las veces que haga falta (no borra datos):

1. Si no existe, arma `deploy/.env.produccion` con secretos nuevos ([`preparar-env.mjs`](../deploy/preparar-env.mjs)): contraseñas de Postgres y de cada base, los tres tokens de servicio, el de métricas, la clave RS256 de identity y la contraseña de los usuarios de prueba. No imprime ninguno. Queda con permisos `600`.
2. Levanta Postgres y Redis.
3. Alinea las contraseñas de los usuarios de cada base con las del archivo (por si el volumen ya existía) e instala PostGIS.
4. Genera el cliente de Prisma y corre las migraciones de las tres bases.
5. Carga los usuarios de prueba (seed de identity).
6. Construye y levanta los tres servicios, nginx y Caddy, y espera a que estén sanos.
7. Arma la demo de flotas y zonas (sin ella, toda solicitud da 422 `ORIGEN_FUERA_DE_ZONA`).

Después, comprobar desde afuera:

```bash
npm run web:probar -- https://viajes.midominio.com deploy/.env.produccion
```

Revisa la CSP, que lo interno no se publica, el 413 en JSON y el SSE sin buffer.

## Qué se les pasa a los grupos atacantes

- La URL: `https://viajes.midominio.com`.
- Los usuarios de prueba (tabla del [README](../README.md#usuarios-de-prueba)) y la contraseña: `IDENTITY_SEED_CONTRASENA` de `deploy/.env.produccion`. Es la única variable de ese archivo que se comparte.
- La referencia de la API: [api.md](api.md).
- Las reglas del ataque ([ataque.md](ataque.md#reglas)): solo este entorno, sin DoS masivo.

## Congelar

Mientras nos atacan, el entorno no se toca. El código que corre es el del tag:

```bash
git tag -a congelado -m "Entorno del ataque cruzado"
git push origin congelado
```

Un hallazgo se corrige en `main`, con su test (ver «Hallazgos recibidos» en [ataque.md](ataque.md)); el entorno congelado se actualiza solo cuando termina el ataque, o si la cátedra lo pide.

## Operación

```bash
C="docker compose -f docker-compose.yml -f deploy/compose.produccion.yml --env-file deploy/.env.produccion"
$C ps                       # estado
$C logs -f dispatch         # una línea JSON por pedido, con requestId
$C restart dispatch         # SIGTERM: drena los pedidos en curso antes de salir (npm run demo:apagado)
$C down                     # bajar todo (los datos quedan en el volumen)
```

Para empezar de cero (borra todos los datos): `$C down -v` y borrar `deploy/.env.produccion`.

Observabilidad (opcional): con las credenciales de Grafana Cloud en `deploy/.env.produccion`, agregar `--profile obs` ([observabilidad.md](observabilidad.md)).
