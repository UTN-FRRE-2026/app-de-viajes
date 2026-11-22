# ADR 0010 — Idempotency-Key obligatoria: cerrojo en Redis y registro en la transacción del efecto

- **Estado:** aceptado
- **Fecha:** 2026-11-22. Registra lo que ya está en `main` (#17 y #26) y lo extiende al registro de identity.
- **Quiénes participaron:** Ivan (implementación y ADR) y Maxi (dueño compartido del ADR en el reparto). Revisión: Agos y Maxi.
- **Servicios:** dispatch e identity; el middleware y el adaptador, en `platform` — PLAN 3.5 y bloque 6 (B6)

## Contexto

Los clientes reintentan: la app del chofer pierde señal justo después de mandar «finalizar», el pasajero toca dos veces «pedir viaje», un proxy repite un pedido que tardó. El servidor no puede distinguir un reintento de una operación nueva si el cliente no se lo dice.

Algunos efectos ya tienen una protección natural en la base: un pasajero no puede tener dos solicitudes activas, un email no se registra dos veces, un viaje no se finaliza dos veces ([ADR 0004](0004-asignacion-unica.md)). Pero eso solo impide el **segundo efecto**; el reintento recibe un 409 (`SOLICITUD_ACTIVA_EXISTENTE`, `TRANSICION_INVALIDA`, `IDENTIFICADOR_EN_USO`) y el cliente no sabe si su pedido anterior funcionó. Y hay efectos que la base no frena sola: el `PUT` de la tarifa crea una versión nueva cada vez, y lo que pasa fuera de la base (la búsqueda de candidatos en location, la llamada al proveedor de pagos) se repite antes de que el índice único frene nada.

Además, dispatch puede correr con más de una instancia, y dos copias del mismo pedido pueden llegar a instancias distintas al mismo tiempo.

## Opciones consideradas

| Opción | Por qué no / por qué sí |
|---|---|
| **Solo las restricciones de la base** | Impiden el doble efecto donde existen, pero el reintento recibe un error en vez de la respuesta original, y no cubren lo que pasa fuera de la base ni los efectos que no tienen una restricción natural |
| **Clave del cliente, guardada solo en Redis** (respuesta con TTL) | La respuesta no se escribe en la misma transacción que el efecto: si el proceso se cae entre el `COMMIT` y el `SET`, el efecto queda sin registro y el reintento lo repite. Redis además puede descartar claves por memoria |
| **Clave del cliente, guardada solo en Postgres** | Correcta: la clave primaria del registro, en la transacción del efecto, impide el segundo. Pero los duplicados simultáneos llegan todos al caso de uso, y cada uno repite lo de afuera (la búsqueda, el cobro) antes de chocar al confirmar |
| **Token emitido por el servidor** (pedir un token y después usarlo) | Un ida y vuelta más en cada operación, y hay que guardar y vencer los tokens emitidos |
| **Clave del cliente, cerrojo en Redis + registro en Postgres** | La elegida: Redis frena los duplicados en vuelo antes del caso de uso, y Postgres da la garantía |

Y, sobre la clave:

| Opción | Por qué no / por qué sí |
|---|---|
| Opcional | Un cliente que se olvida de mandarla queda sin protección, y no se nota en ninguna prueba |
| **Obligatoria en todo lo que crea, cobra o dispara un efecto** | Sin la clave, 400. El cliente genera un UUID por operación y lo repite en cada reintento de esa operación |

## Decisión

El encabezado `Idempotency-Key` (16 a 128 letras, números, `-` o `_`; un UUID sirve) es **obligatorio** en:

- dispatch: crear la solicitud, aceptar la oferta, en camino, iniciar, finalizar, cancelar, `POST /solicitudes/:id/cobrar`, `PUT /admin/tarifas`, las rutas de flotas que cambian algo (entre ellas, la activación de choferes) y `PUT /chofer/disponibilidad`;
- identity: `POST /registro`.

El middleware (`packages/platform/src/idempotencia.ts`) va al final de la cadena de cada ruta, después de autenticar, del rol y de validar: un pedido rechazado no ocupa la clave. Funciona en dos capas:

1. **Cerrojo en Redis** (`SET NX PX`, 30 s) mientras el pedido está en vuelo. Un duplicado simultáneo recibe **409** `CLAVE_IDEMPOTENCIA_EN_CURSO` con `Retry-After: 1`, sin llegar al caso de uso. Se suelta comparando el token, para no soltar el de otro si venció.
2. **Registro en Postgres, en la misma transacción que el efecto** (`idempotency_keys`, en la base de cada servicio): la clave, la huella del pedido, el estado y la respuesta. Si la clave ya está, otro pedido confirmó primero y esta transacción se deshace.

Y además:

- **Huella:** SHA-256 del método, la ruta y el cuerpo ya validado, con las claves ordenadas. La misma clave con otro pedido: **422** `CLAVE_IDEMPOTENCIA_REUTILIZADA`.
- **Reintento:** recibe la respuesta guardada, byte a byte (`json`, no `jsonb`), con `Idempotent-Replayed: true`.
- **Solo se guarda lo que salió bien.** Un error no tuvo efecto, así que el reintento se vuelve a procesar.
- **Alcance:** la clave es de un usuario (el del token); en las rutas de flotas, del usuario y su flota. El mismo valor en dos usuarios son dos operaciones.
- **Falla cerrado:** si Redis no responde, 503 y no se procesa.
- **Retención:** cada respuesta se guarda como mínimo 24 h (`IDEMPOTENCIA_RETENCION_HORAS`). Cada minuto, una purga borra las vencidas por lotes, con `FOR UPDATE SKIP LOCKED`. Pasado ese tiempo, la misma clave vuelve a ejecutar el pedido.
- **El cobro** usa además el id del cobro como clave con el proveedor de pagos, porque esa llamada está fuera de la transacción ([docs/tarifas.md](../tarifas.md)).

**En el registro de identity**, dos diferencias, porque no hay token y el cuerpo tiene la contraseña:

- **El alcance es el email** (su SHA-256, para que Redis no guarde emails en sus claves). La misma clave con otro email es otro registro.
- **La contraseña no entra en la huella.** La huella se guarda en la base, y un SHA-256 sin sal de un cuerpo con la contraseña permitiría probar contraseñas con una copia de la base sin pasar por argon2. Cuentan el email, el nombre y el rol. Un reintento con la misma clave y otra contraseña recibe el 201 guardado; la cuenta queda con la primera.

El middleware, el cerrojo, el almacén en Postgres, el registro en la transacción y la purga están en `platform` (`idempotencia.ts` e `idempotencia-sql.ts`). Cada servicio crea la tabla en su migración y llama a `registrarIdempotenciaEnTransaccion` dentro de la transacción de su caso de uso.

## Consecuencias

- Un reintento recibe lo mismo que el original, aunque el proceso se haya caído después del `COMMIT`: el registro confirmó con el efecto.
- Los duplicados simultáneos no llegan al caso de uso, así que no repiten lo que pasa fuera de la base. Si el cerrojo vence con el pedido todavía en curso, la clave primaria impide igual el segundo efecto: Redis acelera, la garantía la da Postgres.
- **Todos los clientes tienen que mandar la clave:** el frontend genera un UUID por operación y lo guarda hasta tener respuesta; los scripts de carga y los tests también.
- **Cada ruta nueva con efecto tiene que acordarse de `idempotente()`.** Nada lo fuerza: lo cubre la revisión del PR y un test de que sin la clave responde 400.
- Si Redis no responde, las operaciones con efecto no se procesan (503): se elige consistencia sobre disponibilidad.
- La tabla crece con cada pedido con efecto; la purga la mantiene en lo de las últimas 24 h.
- Un pedido que tarda más que el cerrojo (30 s) deja pasar al duplicado hasta el caso de uso, donde lo frena la clave primaria al confirmar (con un 409).

## Cómo se verifica

Contra Postgres y Redis reales:

- dispatch, `tests/seguridad/idempotencia.test.ts`: validación del encabezado; el reintento de cada `POST` repite la respuesta sin repetir el evento; 422 con otro cuerpo u otra ruta; el mismo cuerpo con las claves en otro orden es el mismo pedido; el alcance por usuario; un error no se guarda; Redis caído (503); el cerrojo vencido con el pedido en curso.
- dispatch, `tests/concurrencia/idempotencia.test.ts`: 20 pedidos iguales en simultáneo crean una sola solicitud y hacen una sola búsqueda; 20 finalizaciones, un solo `RideCompleted`.
- dispatch, `tests/integracion/purga-idempotencia.test.ts`: borra solo lo vencido, por lotes, con varias instancias a la vez.
- identity, `tests/integracion/registro-idempotente.test.ts` y `tests/concurrencia/registro-y-login.test.ts`: el reintento del registro recibe el mismo 201 sin volver a correr argon2; 422 con otro nombre o rol; la contraseña no entra en la huella; la respuesta sale de la transacción aunque no se guarde nada después de responder; 20 reintentos simultáneos, un solo usuario y ninguno llega al caso de uso.

Comprobado que fallan sin el cerrojo, sin el registro en la transacción y sin la comparación de la huella (dispatch), y sin el middleware en la ruta, sin el registro en la transacción, con la contraseña en la huella, con un alcance global y con un cerrojo que no frena (identity).

## Qué nos haría cambiar de decisión

- **Redis se vuelve la causa de las caídas.** Si el 503 por Redis pesa más que los duplicados que frena, se puede seguir sin el cerrojo: la clave primaria en Postgres sigue impidiendo el doble efecto, y solo se pierde que los duplicados no lleguen al caso de uso.
- **Pedidos que tardan más que el cerrojo.** Si la medición muestra pedidos de más de 30 s con efecto, se sube `IDEMPOTENCIA_EN_VUELO_SEGUNDOS` o se renueva el cerrojo mientras el pedido sigue.
- **Reintentos después de 24 h.** Si algún cliente reintenta más tarde (por ejemplo, una cola offline en la app), hay que subir la retención, a costa del tamaño de la tabla.
- **Un efecto que sale de la base.** Si otra operación llama a un servicio externo dentro del pedido (como el cobro), ese servicio tiene que aceptar su propia clave de idempotencia; el registro en nuestra transacción no la cubre.
