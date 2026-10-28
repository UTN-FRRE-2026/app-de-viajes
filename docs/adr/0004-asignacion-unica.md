# ADR 0004 — Asignación única: `FOR UPDATE` de la solicitud + restricción única del chofer

- **Estado:** aceptada
- **Fecha:** 2026-10-28
- **Servicio:** dispatch (M5) — problema 6.3

## Contexto

Una solicitud de viaje se ofrece a varios choferes a la vez. Tienen que cumplirse siempre dos invariantes:

1. **Una solicitud tiene como máximo un chofer.** Si dos choferes aceptan a la vez, gana exactamente uno.
2. **Un chofer tiene como máximo un viaje activo.** Si un chofer acepta dos solicitudes a la vez, se le asigna solo una.

Además, cancelar y aceptar pueden llegar juntos, y dispatch va a correr con más de una réplica.
Cualquier solución del tipo "leo el estado y, si está libre, escribo" (*check-then-act*) es incorrecta:
entre la lectura y la escritura, otra transacción puede haber cambiado el estado.

## Decisión

Las dos invariantes las garantiza **Postgres**, dentro de una sola transacción (READ COMMITTED):

```sql
BEGIN;
-- 1. Lock de la solicitud. Las aceptaciones y cancelaciones de la misma solicitud esperan acá, en fila.
SELECT ... FROM ride_requests WHERE id = $solicitud FOR UPDATE;
-- (se relee la oferta después del lock y se valida: solicitud BUSCANDO, oferta PENDIENTE y vigente)
-- 2. "Lock" del chofer: driver_id es clave primaria de driver_active_assignment.
INSERT INTO driver_active_assignment (driver_id, request_id) VALUES ($chofer, $solicitud)
ON CONFLICT DO NOTHING RETURNING driver_id;     -- 0 filas → 409 CHOFER_CON_VIAJE_ACTIVO
-- 3. Efectos
UPDATE ride_requests SET status = 'ASIGNADO', driver_id = $chofer, version = version + 1 WHERE id = $solicitud;
INSERT INTO offers ... ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;  -- aceptada + otras canceladas
INSERT INTO outbox (type, payload, ...) VALUES ('TripAssigned', ...);
COMMIT;
```

- **Invariante 1:** la segunda aceptación espera el lock; cuando la primera confirma, lee `ASIGNADO` → 409 `SOLICITUD_NO_DISPONIBLE`.
  Como segunda barrera, `driver_active_assignment.request_id` también es `UNIQUE`.
- **Invariante 2:** dos aceptaciones del mismo chofer bloquean solicitudes *distintas*, así que no se esperan entre sí.
  Las frena la clave primaria: Postgres hace esperar al segundo `INSERT` hasta que el primero confirme o haga rollback.
  Si confirmó, hay conflicto. Usamos `ON CONFLICT DO NOTHING` en lugar de capturar el error de unicidad para no dejar la transacción abortada.
- **Cancelar contra aceptar:** la cancelación toma el mismo lock primero. Hay dos resultados, ambos válidos:
  (a) gana la cancelación → la aceptación recibe 409; (b) gana la aceptación → la cancelación cancela un viaje asignado y borra la fila de `driver_active_assignment` en la misma transacción.
- **Vencimiento:** la vigencia de la oferta se compara con el reloj del servidor al aceptar, así que una oferta vencida no se puede aceptar aunque el barrido todavía no haya pasado.

### Orden de los locks (por qué no hay interbloqueo)

Todos los casos de uso que modifican una solicitud (aceptar, cancelar, vencer ofertas, liberar chofer) bloquean **primero la solicitud** y en ningún caso bloquean dos solicitudes.
El chofer no se bloquea con un lock de fila sino con una restricción única. No existe un par de transacciones que tenga A y espere B mientras la otra tiene B y espera A.

Si, por ejemplo, la cancelación bloqueara primero al chofer y después la solicitud, mientras la aceptación lo hace al revés, se podría dar ese ciclo. Postgres lo detectaría y abortaría una de las dos con `deadlock detected`, que el usuario vería como un error 500.

## Alternativas consideradas

| Alternativa | Por qué no |
|---|---|
| **Mutex en memoria** (en el proceso de Node) | Solo sirve dentro de un proceso. Con dos réplicas de dispatch, cada una tiene su mutex y la carrera vuelve. |
| **Lock distribuido en Redis** (`SET NX PX`) | Puede vencer en medio de la operación (pausa de GC, red lenta) y deja dos dueños. Tampoco es atómico con la escritura en Postgres: el lock y el dato viven en sistemas distintos. Hay que agregar *fencing tokens* para que sea correcto, y eso es más complejo que usar la base. |
| **Bloqueo optimista** (`UPDATE ... WHERE id = $1 AND version = $2`, reintentar si 0 filas) | Correcto para la invariante 1 y sin esperas. Con 50 choferes compitiendo, 49 fallan y reintentan (o se rinden); como cada aceptación fallida es igual un 409, sería viable. Lo descartamos porque no resuelve la invariante 2 (dos solicitudes distintas no comparten versión) y porque el lock pesimista hace más fácil de explicar el orden de los efectos. La columna `version` queda para auditoría y para ETags. |
| **Aislamiento SERIALIZABLE** | Postgres detecta la anomalía y aborta con `could not serialize`, y la aplicación tiene que reintentar. Es correcto pero más caro, los errores dependen del plan de ejecución, y hay que escribir los reintentos en cada camino. |
| **Una cola por solicitud** (procesar las aceptaciones de a una con un consumidor) | Serializa sin locks, pero agrega latencia y otro componente. La respuesta HTTP al chofer quedaría asíncrona. |

## Consecuencias

- La garantía no depende de cuántas réplicas de dispatch haya.
- Las aceptaciones de una misma solicitud se ejecutan de a una. Es aceptable porque cada transacción dura pocos milisegundos y la contención es por solicitud, no global.
- Bajo mucha contención, las transacciones esperan el lock y una conexión del pool. Por eso `maxWait` y `timeout` están en 10 s.
- Toda la lógica de concurrencia está en `services/dispatch/src/infra/db/repositorio-prisma.ts`. El dominio expresa el orden (primero `obtenerSolicitudParaActualizar`) y el adaptador lo implementa en SQL. Con `DISPATCH_LOG_SQL=1` se ve el SQL en el log.

## Cómo se verifica

`services/dispatch/tests/concurrencia/asignacion-unica.test.ts`, contra Postgres real:

- 50 choferes aceptan la misma solicitud → exactamente 1×200 y 49×409, y la base lo confirma (1 fila de asignación, 1 `TripAssigned`).
- Un chofer acepta dos solicitudes a la vez (20 repeticiones) → 1×200 y 1×409 `CHOFER_CON_VIAJE_ACTIVO`, y la perdedora queda intacta.
- Cancelar contra aceptar (20 repeticiones) → siempre `CANCELADO_PASAJERO`, sin chofer bloqueado, y eventos coherentes con quién ganó.

Los tests agregan una demora de 15 ms dentro de la transacción, después de leer la solicitud (`tests/soporte/demora.ts`). Sin esa demora, una transacción dura ~1 ms y los pedidos llegan escalonados, así que la carrera casi no se da.

Lo comprobamos sacando el `FOR UPDATE`: el test de las 50 aceptaciones seguía en verde. Con la demora, sacar el `FOR UPDATE` hace fallar dos tests, y sacar la reserva del chofer hace fallar otros dos.
