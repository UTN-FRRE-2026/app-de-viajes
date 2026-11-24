# ADR 0011 — Vencimiento de ofertas: reloj del servidor al aceptar y barrido periódico en Postgres

- **Estado:** aceptado
- **Fecha:** 2026-11-24. Registra lo que ya está en `main`: el barrido existe desde el PR #1 y busca con las reglas de zonas desde #36.
- **Quiénes participaron:** Ivan (implementación y ADR). Revisión: pendiente (Agos y Maxi).
- **Servicio:** dispatch — problema 6.3 (asignación) y PLAN 3.5

## Contexto

Una solicitud se ofrece a una tanda de `OFERTAS_SIMULTANEAS` choferes (3 por defecto). Cada oferta vence a los `OFERTA_TTL_SEGUNDOS` (15 por defecto). Si nadie acepta, la solicitud tiene que pasar a los siguientes choferes; si no queda ninguno, terminar en `SIN_CHOFERES`.

Hay que resolver tres cosas:

1. **Quién decide que una oferta venció.** No puede ser el celular del chofer: puede perder señal, tener la hora mal o no avisar nunca.
2. **Quién pasa la solicitud a la tanda siguiente**, aunque nadie la esté mirando.
3. **Qué pasa si el chofer acepta justo cuando vence.** Aceptar y vencer escriben la misma oferta y la misma solicitud.

Además, dispatch puede correr con más de una réplica, y se reinicia en cada despliegue.

## Opciones consideradas

| Opción | Por qué no / por qué sí |
|---|---|
| **`setTimeout` en memoria** por oferta | Se pierde con un reinicio o un despliegue, y la solicitud queda colgada en `BUSCANDO`. Con varias réplicas, el timer vive solo en la que creó la oferta |
| **TTL de Redis con keyspace notifications** (`expired`) | Las notificaciones son Pub/Sub sin persistencia: si dispatch no está suscrito en ese momento, el aviso se pierde. Redis emite `expired` cuando borra la clave, que puede ser más tarde que el TTL. Hay que habilitar `notify-keyspace-events` en el servidor. Con varias réplicas, todas reciben el aviso y hay que coordinarlas igual. Y la oferta vive en Postgres: serían dos fuentes de verdad |
| **Cola con demora** (BullMQ u otra) | Una dependencia y un worker más. Si el trabajo se encola después del `COMMIT` y el proceso se cae en el medio, se pierde (haría falta un outbox para encolar). El trabajo igual tiene que tomar el lock de la solicitud y revalidar en Postgres, y no reemplaza el chequeo al aceptar |
| **Vencimiento perezoso** (solo al leer) | Correcto para aceptar y para mostrar, pero nadie lee una oferta que nadie mira: la solicitud no pasaría al siguiente chofer hasta que alguien la consulte. Lo usamos como complemento, no como único mecanismo |
| **Reloj del servidor al leer + barrido periódico en Postgres** | La elegida. La vigencia se decide con el reloj del servidor en cada lectura; el barrido solo marca y pasa de tanda. Todo con la base como única fuente y el mismo lock que aceptar ([ADR 0004](0004-asignacion-unica.md)) |

## Decisión

**El vencimiento es un dato, no un evento:** cada oferta guarda `expires_at` y la vigencia se calcula con el reloj del servidor. Un barrido periódico hace lo que nadie pide: marcar las vencidas y ofrecer a los siguientes.

- **Al crear la tanda** (`ofrecer.ts`), todas las ofertas reciben el mismo `venceEn = ahora + OFERTA_TTL_SEGUNDOS`.
- **Vigente** es `PENDIENTE` y `ahora < venceEn` (`Oferta.estaVigente`; el instante de vencimiento ya cuenta como vencida). Con esa regla:
  - aceptar una oferta vencida da 409 `OFERTA_VENCIDA`, aunque el barrido todavía no la haya marcado;
  - `GET /chofer/estado` no la muestra (`expires_at > ahora` en la consulta) y devuelve `ahora` para que el cliente cuente con el reloj del servidor.
- **El barrido** (`vencer-ofertas.ts`) corre cada `BARRIDO_INTERVALO_MS` (2000 ms por defecto) con `iniciarBarrido` de `platform`, que nunca superpone dos pasadas en el mismo proceso. En cada pasada:
  1. busca hasta 100 solicitudes con ofertas `PENDIENTE` y `expires_at <= ahora` (índice `offers(status, expires_at)`);
  2. por cada una, **fuera de la transacción**, busca candidatos: location y el filtro de aptos de la zona, sin los choferes ya ofrecidos;
  3. en una transacción: `FOR UPDATE` de la solicitud, relee sus ofertas, marca `VENCIDA` las que correspondan y registra un `OfferExpired` por cada una en el outbox;
  4. si la solicitud sigue `BUSCANDO` y no le queda ninguna oferta vigente, ofrece a una tanda nueva con los candidatos que no estén entre los ofrecidos (releídos con el lock). Sin candidatos: `SIN_CHOFERES` y `NoDriversFound`.
- **Un chofer no recibe dos veces la misma solicitud:** se excluyen los ya ofrecidos, y además `offers(request_id, driver_id)` es único.
- **Si location falla**, el error sube, la solicitud sigue `BUSCANDO` y el próximo barrido reintenta. Un location caído no se confunde con «no hay choferes».
- **Apagado:** `detenerBarrido` espera a que termine la pasada en curso.

### Aceptar contra vencer

Aceptar y el barrido toman **el mismo lock** (`FOR UPDATE` de la solicitud) y releen las ofertas después de tomarlo. Hay dos órdenes posibles, y los dos dejan un estado válido:

| Quién toma el lock primero | Resultado |
|---|---|
| El barrido | Marca la oferta `VENCIDA` (y quizá ofrece a otros). La aceptación espera, relee, encuentra la oferta vencida y responde 409 `OFERTA_VENCIDA`. Su transacción se deshace entera |
| La aceptación | Asigna, marca la oferta `ACEPTADA` y cancela las otras de la tanda. El barrido espera, relee, no encuentra pendientes y, como la solicitud ya no está `BUSCANDO`, no ofrece a nadie |

Si la aceptación llega con la oferta ya vencida y el barrido todavía no pasó, decide el reloj del servidor, leído **después** del lock: 409 `OFERTA_VENCIDA`.

**Con varias réplicas**, dos barridos sobre la misma solicitud se ordenan por el mismo lock. El segundo relee, encuentra la tanda nueva vigente (o la solicitud ya no `BUSCANDO`) y no hace nada.

## Consecuencias

- El vencimiento no depende del cliente ni de un proceso vivo. Si dispatch se reinicia, el primer barrido procesa lo que quedó atrasado.
- **La aceptación se corta exacto a los 15 s**, pero pasar a la tanda siguiente puede tardar hasta un intervalo más: 15 s + 2 s, más los 100 ms del relay para que llegue la oferta por SSE ([ADR 0007](0007-tiempo-real-sse.md)).
- Cuesta una consulta por índice cada 2 s, aunque no haya nada vencido.
- Las solicitudes de una pasada se procesan en serie, cada una con su búsqueda en location. Con location lento, una pasada con muchas solicitudes se alarga y atrasa la siguiente. Más de 100 solicitudes vencidas quedan para la pasada siguiente.
- Con varias réplicas, todas barren: la búsqueda en location se repite, pero el efecto es uno solo por el lock.
- Los candidatos se buscan sin lock y pueden quedar viejos. La aceptación revalida al chofer con locks ([ADR 0004](0004-asignacion-unica.md)).
- No hay rechazo explícito: no existe una ruta para que el chofer rechace. Una oferta se acepta, vence o se cancela (cuando otro acepta o se cancela la solicitud).
- La métrica `dispatch_ofertas_vencidas_total` cuenta las vencidas, después del `COMMIT` de cada solicitud.

## Cómo se verifica

- `services/dispatch/tests/dominio/entidades.test.ts`: la oferta está vigente hasta el instante de vencimiento (exclusivo); aceptar una vencida falla aunque el barrido no haya pasado; `vencerSiCorresponde` solo actúa sobre pendientes ya vencidas.
- `services/dispatch/tests/dominio/casos-uso.test.ts`: una oferta vencida no se puede aceptar sin barrido; al vencer la tanda se ofrece a los siguientes; sin más candidatos, `SIN_CHOFERES`; antes del vencimiento, el barrido no hace nada.
- `services/dispatch/tests/integracion/flujo.test.ts`: el barrido vence ofertas en Postgres y pasa al siguiente chofer.
- `services/dispatch/tests/integracion/estado-chofer.test.ts`: `GET /chofer/estado` no muestra una oferta vencida aunque el barrido todavía no la haya marcado.
- `services/dispatch/tests/integracion/location.test.ts` y `tests/dominio/zonas-busqueda.test.ts`: con location caído, el barrido no marca `SIN_CHOFERES` y reintenta en la pasada siguiente.
- `services/dispatch/tests/dominio/metricas.test.ts`: el barrido cuenta las vencidas, y nada antes del vencimiento.
- `e2e/tests/03-oferta-vence.spec.ts`, con `OFERTAS_SIMULTANEAS=1` y `OFERTA_TTL_SEGUNDOS=6` (`e2e/levantar.mjs`): el chofer más cercano deja vencer la oferta, desaparece de su pantalla y el viaje se le ofrece al segundo, que lo acepta.

**Falta:** ningún test superpone, contra Postgres, una aceptación con el barrido, ni dos barridos sobre la misma solicitud. Las garantías salen del mismo `FOR UPDATE` que sí está probado en `tests/concurrencia/asignacion-unica.test.ts`. Está anotado en el inventario de carreras ([ADR 0012](0012-inventario-carreras.md)).

## Qué nos haría cambiar de decisión

- **Los 2 s extra pesan en el tiempo hasta la asignación.** Se baja `BARRIDO_INTERVALO_MS` (el mínimo es 100 ms), o se programa la pasada siguiente para el `expires_at` más cercano en lugar de un intervalo fijo.
- **El barrido no da abasto.** Si la métrica de vencidas muestra atraso sostenido, o las pasadas tardan más que el intervalo, se procesan varias solicitudes en paralelo o se reparte el trabajo entre réplicas con `FOR UPDATE SKIP LOCKED` en la selección, como el relay del outbox.
- **Se agrega el rechazo explícito.** Rechazar marcaría la oferta y pasaría de tanda en el momento, con el mismo lock. El barrido seguiría para las que nadie responde.
