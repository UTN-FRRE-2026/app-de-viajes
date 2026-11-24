# ADR 0009 — Límite de choferes activos por flota: `UPDATE` condicional del contador y `CHECK` (la carrera G)

- **Estado:** aceptado
- **Fecha:** 2026-11-24. Registra lo que ya está en `main`: el PR 1 de flotas (migración `20261126000000_flotas`). Las mutaciones del test se comprobaron el 21/11.
- **Quiénes participaron:** Agos (implementación; dueña de la variante G y del ADR en el reparto). Redacción: Ivan. Revisión: pendiente (Agos y Maxi).
- **Servicio:** dispatch (flotas) — variante G, PLAN 3.3 y 3.5

## Contexto

Cada flota tiene un máximo de choferes activos (`max_active`). Activar a un chofer inactivo ocupa un cupo; desactivarlo, o que el admin lo deshabilite, lo libera ([docs/flotas.md](../flotas.md#qué-ocupa-un-cupo-y-qué-lo-libera)).

Tienen que cumplirse siempre:

1. **Los activos de una flota no pasan de `max_active`**, aunque lleguen muchas activaciones a la vez.
2. **El contador coincide con los activos reales**, aunque se mezclen activaciones y desactivaciones.
3. **Un chofer ocupa un solo cupo**, aunque lleguen dos pedidos para él con claves distintas.

Dispatch puede correr con más de una réplica. Leer cuántos hay y, si queda lugar, activar (*check-then-act*) es incorrecto: dos transacciones leen 9 de 10 a la vez y las dos activan.

## Opciones consideradas

| Opción | Por qué no / por qué sí |
|---|---|
| **Contar los activos al activar** (`SELECT count(*) … WHERE active` y, si es menor, activar) | En READ COMMITTED, dos transacciones cuentan 9 a la vez y las dos activan: es el *check-then-act*. Para que fuera correcto habría que bloquear la flota igual, o pasar a `SERIALIZABLE` y reintentar. Y un `CHECK` no puede contar filas: la base no tendría red de seguridad |
| **`SELECT … FROM fleets FOR UPDATE`, comparar en el código y escribir** | Correcto: serializa las activaciones de la flota. Pero son dos sentencias con la comparación en JS entre medio, y un descuido (sacar el lock, comparar con `<=`) rompe la garantía sin que se note. El `UPDATE` condicional bloquea la misma fila y compara en la misma sentencia |
| **Cerrojo en Redis por flota** (`SET NX PX`) | Puede vencer en medio de la operación y no es atómico con la escritura en Postgres ([ADR 0004](0004-asignacion-unica.md)). El contador seguiría en Postgres |
| **Contador en Redis** (`INCR` con tope en Lua) | Atómico, pero fuera de la transacción que activa al chofer: si esa transacción hace rollback, hay que devolver el cupo a mano. Y dos fuentes de verdad para el mismo número |
| **`UPDATE … WHERE active_count < max_active` + `CHECK`** | La elegida: comparar y sumar en una sentencia, en la misma transacción que el cambio del chofer |

## Decisión

Todo en una transacción READ COMMITTED (`RepositorioFlotasPrisma.enTransaccion`, en `services/dispatch/src/infra/db/flotas-prisma.ts`):

```sql
BEGIN;
-- 1. Lock del chofer: dos pedidos sobre el mismo chofer se hacen en fila.
SELECT ... FROM drivers WHERE id = $chofer FOR UPDATE;
-- (el caso de uso exige que sea de la flota del token, si no 404, y que esté habilitado, si no 409)
-- 2. Solo si pasa de inactivo a activo: comparar y sumar en una sentencia.
UPDATE fleets SET active_count = active_count + 1, updated_at = now()
WHERE id = $flota AND active_count < max_active
RETURNING active_count;                 -- 0 filas → 409 LIMITE_FLOTA_ALCANZADO y rollback
-- 3. El chofer y la Idempotency-Key, en la misma transacción.
UPDATE drivers SET active = true, ... WHERE id = $chofer;
INSERT INTO idempotency_keys ...;
COMMIT;
```

- **Por qué alcanza:** el `UPDATE` toma el lock de la fila de la flota. Una activación simultánea espera; cuando la primera confirma, Postgres vuelve a evaluar el `WHERE` con la fila nueva. Con 10 cupos, la undécima ve `active_count = 10` y no actualiza nada.
- **La red de seguridad:** `CHECK fleets_cupo_check (active_count >= 0 AND active_count <= max_active)`. Si algún camino nuevo se saltea el `UPDATE` condicional, la base rechaza el contador igual.
- **Liberar:** desactivar o deshabilitar a un chofer activo resta 1 en la misma transacción. Solo libera si estaba activo: lo dice la entidad (`ChoferFlota.desactivar()`). Activar a uno ya activo o cambiar la disponibilidad no tocan el contador.
- **Orden de los locks:** siempre el chofer y después la flota. Activar, desactivar y deshabilitar lo respetan, así que no se bloquean entre sí.
- **Idempotency-Key:** obligatoria, con alcance por usuario y flota ([ADR 0010](0010-idempotencia.md)). Se registra en la misma transacción: un reintento no ocupa otro cupo.

**Bajar el límite** (`PUT /admin/flotas/:id`, `guardarFlota`):

```sql
INSERT INTO fleets (id, name, max_active) VALUES ($id, $nombre, $max)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, max_active = EXCLUDED.max_active, updated_at = now()
  WHERE fleets.active_count <= EXCLUDED.max_active
RETURNING id;                            -- 0 filas → 409 LIMITE_MENOR_QUE_ACTIVOS
```

- Si el límite nuevo queda por debajo de los activos, **no cambia nada**, ni el nombre, y no se desactiva a nadie. El `admin_flota` tiene que desactivar antes a los que sobran.
- Igual o mayor que los activos, pasa. Igual deja la flota llena.
- Toma el lock de la misma fila que una activación: si hay una en curso, la espera y compara con el contador confirmado. Una activación que espera detrás vuelve a evaluar `active_count < max_active` con el límite nuevo. El `CHECK` cubre lo que quede.

## Consecuencias

- La garantía no depende de cuántas réplicas de dispatch haya.
- El cliente recibe un 409 claro (`LIMITE_FLOTA_ALCANZADO`), no un 500: el `CHECK` solo es la red de seguridad.
- **Las activaciones de una misma flota se hacen en fila**, desde el `UPDATE` hasta el `COMMIT`. Flotas distintas no se esperan. Es aceptable porque la transacción es corta; `maxWait` y `timeout` están en 10 s.
- **El contador está desnormalizado.** Ningún `CHECK` lo compara con los activos reales, porque un `CHECK` no mira otras filas. Si alguien escribe `drivers.active` sin pasar por el caso de uso (a mano en la base, una migración), se desincroniza. Los tests comparan el contador con el `count(*)` real.
- **El límite cuenta activos, no choferes con viaje.** Desactivar a un chofer con un viaje en curso libera su cupo y el viaje sigue ([docs/flotas.md](../flotas.md#aceptar-revalidación-y-la-carrera-con-la-flota)). Por un rato, la flota puede tener más choferes trabajando que `max_active`.
- **Bajar el límite no es automático:** hay que desactivar primero a los que sobran.

## Cómo se verifica

`services/dispatch/tests/concurrencia/flotas.test.ts`, contra Postgres real. Cada transacción espera 50 ms con el chofer ya bloqueado y antes de tocar la flota (`trasBloquearChofer`), para que las activaciones se superpongan de verdad:

- **50 activaciones simultáneas de choferes distintos con límite 10:** exactamente 10×200 y 40×409 `LIMITE_FLOTA_ALCANZADO`. En Postgres, 10 activos y el contador en 10; los que respondieron 200 son exactamente los activos; 10 claves registradas.
- Dos pedidos para el mismo chofer con claves distintas: un solo cupo.
- 20 pedidos con la misma clave: un solo efecto y una sola clave.
- Activaciones y desactivaciones mezcladas: el contador coincide con los activos y no pasa de 5.
- Dos flotas a la vez: llenar una no consume el cupo de la otra.

`services/dispatch/tests/integracion/flotas.test.ts`: desactivar y deshabilitar liberan el cupo; con 2 activos, bajar el límite a 1 da 409 y no cambia nada, y a 2 pasa; el `CHECK` rechaza un contador de 2 con límite 1, y uno de −1.

**Comprobado que fallan** sin cada protección (21/11, [docs/flotas.md](../flotas.md#cómo-se-sabe-que-el-test-detecta-la-falta-de-la-protección)):

| Sin… | Qué pasa |
|---|---|
| la condición `active_count < max_active` (queda el `CHECK`) | El `CHECK` rechaza los excedentes como 500: ningún 409 |
| la condición y el `CHECK` | Quedan 50 activos con límite 10 |
| el `UPDATE` atómico (leer, comparar en JS y escribir `leído + 1`) | Los 50 quedan activos y el contador se desincroniza |
| el `FOR UPDATE` del chofer | Un chofer activo y el contador en 2 |
| liberar el cupo al desactivar | El contador queda alto y la flota se llena para siempre |

**Sin test concurrente:** bajar el límite mientras llegan activaciones ([ADR 0012](0012-inventario-carreras.md), fila 18). Lo cubren el mismo lock de fila y el `CHECK`. Desde afuera, por HTTP, la carrera G está en [docs/ataque.md](../ataque.md).

## Qué nos haría cambiar de decisión

- **Un límite que dependa de algo más que un número**, por ejemplo por zona o por horario. Un contador por flota no alcanza: haría falta un contador por (flota, zona) con su propio `CHECK`.
- **Choferes o flotas en otro servicio.** El contador y el chofer tienen que confirmar en la misma transacción; si quedaran en bases distintas, haría falta una reserva con compensación, como en el [ADR 0004](0004-asignacion-unica.md).
- **Un contador desincronizado en producción.** Se mantiene con un trigger sobre `drivers.active`, o se agrega una tarea que lo compare con el `count(*)` y avise.
- **Contención medida en una flota grande.** Si muchas activaciones de la misma flota esperan el lock o agotan el pool, se acorta lo que pasa entre el `UPDATE` y el `COMMIT`; la garantía sigue en la misma sentencia.
