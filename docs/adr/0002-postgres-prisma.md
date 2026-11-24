# ADR 0002 — PostgreSQL con PostGIS, una base por servicio, y Prisma con SQL a mano donde Prisma no llega

- **Estado:** aceptado
- **Fecha:** 2026-11-24. Registra lo que ya está en `main`: Postgres y Prisma desde el PR #1 (migración `20261028000000_inicial` de dispatch), PostGIS desde las zonas (`20261127000000_zonas`).
- **Quiénes participaron:** Agos (dueña del ADR en el reparto). Redacción: Ivan. Revisión: pendiente (Agos y Maxi).
- **Alcance:** los tres servicios (identity, dispatch y location) y `platform` (el SQL de la idempotencia)

## Contexto

Las invariantes del sistema las garantiza la base, no el código ([ADR 0004](0004-asignacion-unica.md), [0012](0012-inventario-carreras.md)): un chofer por viaje, un viaje activo por chofer y por pasajero, el límite de la flota, un cobro por viaje. Para eso hacen falta:

- transacciones con locks de fila (`FOR UPDATE`, `FOR SHARE`, `FOR NO KEY UPDATE`) y `UPDATE` condicionales que Postgres reevalúa en READ COMMITTED;
- `INSERT … ON CONFLICT`, índices únicos parciales, `CHECK` y advisory locks;
- `FOR UPDATE SKIP LOCKED` para que varias réplicas repartan trabajo (el relay del outbox, la purga de la idempotencia, la retención del historial);
- polígonos para las zonas de la variante G: en qué zona cae un origen y que dos zonas no se superpongan.

Además, son tres servicios y ninguno lee la base de otro ([ADR 0006](0006-tres-microservicios.md)). `npm run setup`, los tests y el CI arrancan de una base vacía, así que el esquema tiene que salir de migraciones versionadas.

## Opciones consideradas

**La base:**

| Opción | Por qué no / por qué sí |
|---|---|
| **MongoDB** | Los datos son relacionales: solicitud → ofertas → asignación → cobro, flota → choferes → zonas, con claves foráneas. Las invariantes se apoyan en `CHECK` entre columnas, índices únicos parciales y locks de fila. En Mongo habría que rehacer cada una con otras herramientas, y sus transacciones de varios documentos abortan ante un conflicto y obligan a reintentar en cada camino |
| **Una sola base compartida por los tres servicios** | La cátedra lo permite, pero invita a que un servicio lea las tablas de otro. Con una base y un usuario por servicio, eso falla por permisos |
| **Zonas en JavaScript** (punto en polígono con una librería) | Habría que cargar todas las zonas en cada creación, validar los polígonos y controlar la superposición a mano, en la misma transacción que la escritura. PostGIS trae `ST_Covers`, `ST_IsValid`, `ST_Intersects` y el índice GIST |
| **PostgreSQL 16 con PostGIS, una base por servicio** | La elegida: todas las piezas de la lista de arriba, en un motor |

**El acceso a la base:**

| Opción | Por qué no / por qué sí |
|---|---|
| **SQL crudo con `pg`** | Control total, pero sin cliente tipado para lo simple (leer una solicitud, crear un ping) y sin migraciones: habría que sumar otra herramienta |
| **Knex** | Constructor de consultas y migraciones en JS. Los locks seguirían siendo SQL o casi, y no genera tipos a partir de un esquema |
| **TypeORM** | Entidades como clases con decoradores. El dominio ya tiene sus entidades sin infraestructura (arquitectura hexagonal): serían dos clases por tabla. Para los locks igual haría falta SQL |
| **Drizzle** | Esquema en TypeScript y un constructor más cercano al SQL: habría reducido el SQL a mano. Cambiarlo ahora reescribe los repositorios de los tres servicios sin cambiar ninguna garantía |
| **Prisma, con SQL a mano para lo que no expresa** | La elegida: esquema declarativo, cliente tipado generado y `prisma migrate deploy` con su tabla `_prisma_migrations` |

## Decisión

**Postgres.** Imagen `postgis/postgis:16-3.4`, la misma en el Compose, el CI y el entorno de carga. Un contenedor con **una base y un usuario por servicio** (`identity_svc`, `dispatch_svc`, `location_svc`), cada base con `REVOKE ALL … FROM PUBLIC` (`infra/postgres/init/01-bases-por-servicio.sh`). Los ids que cruzan bases (el `sub` del token, `users.fleet_id`) se guardan como UUID **sin clave foránea** ([docs/modelo.md](../modelo.md)). PostGIS solo está en `dispatch` y `dispatch_test`.

**Prisma 7.10.1** con el adaptador `@prisma/adapter-pg`. Cada servicio tiene su `prisma/schema.prisma`, su cliente generado en `src/infra/db/generated` (no se commitea) y sus migraciones en `prisma/migrations`. Se aplican con `prisma migrate deploy`: en `npm run setup`, en el `globalSetup` de los tests y en el CI.

**Lo que Prisma no expresa va a mano en el SQL de la migración**, bajo un comentario «Agregado a mano»:

- `CHECK`: estados y roles (son `text` con `CHECK`, no enums, para que el SQL crudo no necesite casts), coherencia (`ride_requests_con_chofer_check`), el cupo de la flota (`fleets_cupo_check`), el email en minúsculas;
- índices parciales: `ride_requests_una_activa_por_pasajero` y `pings_sin_clasificar_idx`;
- PostGIS: `CREATE EXTENSION IF NOT EXISTS postgis`, `area geometry(Polygon, 4326)` (en el esquema, `Unsupported`), el índice GIST y `CHECK (ST_IsValid(area))`.

**Las consultas:**

- Lo simple, con la API tipada: `findUnique`, `createMany` con `skipDuplicates`, `update`.
- Los locks y lo que Prisma no sabe escribir, con `$queryRaw` y `$executeRaw` como plantilla etiquetada: cada `${valor}` viaja como parámetro, nunca concatenado. Los fragmentos reusables, con `Prisma.sql`. `$queryRawUnsafe` no aparece en `src/`, solo en tests.
- Las transacciones, con `$transaction` interactiva, `ReadCommitted`, `maxWait` y `timeout` de 10 s.

| SQL a mano | Dónde |
|---|---|
| `FOR UPDATE` de la solicitud, `FOR SHARE` del chofer y de la zona de su flota | `services/dispatch/src/infra/db/repositorio-prisma.ts` |
| `UPDATE` condicional del cupo, advisory lock de las zonas, `FOR NO KEY UPDATE` de la flota, `ST_*` | `services/dispatch/src/infra/db/flotas-prisma.ts` |
| `FOR UPDATE SKIP LOCKED` del relay | `services/dispatch/src/infra/tiempo-real/outbox-prisma.ts` |
| Advisory lock por familia y `UPDATE … WHERE used_at IS NULL` | `services/identity/src/infra/db/repositorio-prisma.ts` |
| Purga de la idempotencia con `SKIP LOCKED` | `packages/platform/src/idempotencia-sql.ts` |
| Retención del historial con `SKIP LOCKED`; `DISTINCT ON` de la ingenua | `services/location/src/infra/db/retencion.ts`, `repositorio-ingenuo.ts` |

Todo esto vive en `src/infra/db` de cada servicio. El dominio habla con puertos y tiene adaptadores en memoria para sus tests.

## Consecuencias

- Las invariantes no dependen de cuántas réplicas haya: las decide Postgres.
- **El `schema.prisma` no muestra todo.** Los `CHECK`, los índices parciales y el GIST están solo en el SQL. [docs/modelo.md](../modelo.md) los junta en un lugar.
- **Una migración nueva no conoce lo agregado a mano.** Al sumar un estado, hay que reescribir el `CHECK` y el índice parcial en el SQL, como en `20261121000000_estados_viaje`.
- **Dos vocabularios.** Los modelos están en castellano con `@map`, y el SQL crudo usa los nombres de la base (`drivers.active`). Los tipos de las filas (`FilaChofer`, `FilaFlota`) se escriben a mano: si cambia una columna, el compilador no avisa. Lo atrapan los tests contra Postgres.
- **PostGIS pide superusuario** para crear la extensión, y `dispatch_svc` no lo es. La instala el init de Postgres o `npm run setup`; sin ella, la migración de zonas falla con 42501 ([docs/flotas.md](../flotas.md)).
- **Hay que generar el cliente** antes de compilar o testear. Lo hacen `npm run setup` y los scripts `build`, `typecheck` y `test` de cada servicio (`prisma generate && …`).
- **Los tests de integración y de concurrencia necesitan Postgres real, con PostGIS.** `test:dominio` corre sin Docker.
- **Las tres bases comparten el contenedor:** están separadas en datos y permisos, no en recursos. Si Postgres se cae, se caen las tres.

## Cómo se verifica

Cada `npm test` aplica todas las migraciones con `prisma migrate deploy` antes de empezar (`tests/soporte/preparar-bd.ts` de cada servicio), y el CI corre contra `postgis/postgis:16-3.4`. Así, el SQL a mano se ejecuta en cada corrida. Además, contra Postgres real:

- dispatch, `tests/integracion/flotas.test.ts` («restricciones de la base»): `fleets_cupo_check`, `drivers_activo_habilitado_check` y `drivers_disponible_activo_check` rechazan una escritura directa;
- dispatch, `tests/concurrencia/asignacion-unica.test.ts`: el índice parcial deja una sola solicitud activa con 10 pedidos a la vez;
- dispatch, `tests/integracion/zonas.test.ts`: polígono inválido (422, lo decide PostGIS), superposición (409), dos `PUT` simultáneos (pasa uno, por el advisory lock), la regla del borde;
- `SKIP LOCKED` con varias instancias: dispatch `tests/concurrencia/relay.test.ts` (4 relays, 300 eventos) y `tests/integracion/purga-idempotencia.test.ts`. La retención de location (`tests/integracion/retencion.test.ts`) se prueba con una sola instancia;
- inyección SQL en la única búsqueda con texto libre: dispatch `tests/seguridad/http.test.ts`;
- `/ready` compara las carpetas de `prisma/migrations` con `_prisma_migrations` (`src/infra/db/salud.ts` de cada servicio). location `tests/seguridad/http.test.ts` prueba el caso sano; **no hay test** del 503 con una migración pendiente.

## Qué nos haría cambiar de decisión

- **Que el SQL a mano crezca más que la API tipada.** Si los repositorios pasan a ser casi todo `$queryRaw`, Prisma aporta poco: Drizzle o `pg` directo, con los tipos de las filas generados, serían más honestos.
- **Un servicio que necesite otra forma de guardar.** Cada servicio tiene su base y su puerto: puede cambiar de motor sin tocar a los otros. Por ejemplo, el historial de location en una base de series de tiempo.
- **Que un fallo de Postgres tumbe los tres servicios en el entorno publicado.** Se separan las bases en contenedores (o instancias) distintos; el código no cambia, solo las URL.
