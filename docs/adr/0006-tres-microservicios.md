# ADR 0006 — Tres microservicios: identity, dispatch (viajes, flotas y tarifas) y location

- **Estado:** aceptado
- **Fecha:** 2026-11-13 (plan v2, PR #4). Escrito como ADR el 2026-11-20.
- **Quiénes participaron:** Ivan redactó el plan v2 con la respuesta de la cátedra; Maxi lo revisó y lo aprobó (PR #4). Revisión de este ADR: Agos y Maxi.
- **Alcance:** todo el sistema

## Contexto

- El plan original tenía **nueve servicios** (M1 a M9), uno por módulo del primer enunciado del Integrador.
- El enunciado nuevo ya no los pide, y ninguno de los dos documentos (ProgIV y el Integrador) menciona microservicios.
- La cátedra respondió **de palabra** que exige **como mínimo tres microservicios, cada uno en su propio contenedor**, que pueden compartir la base, y que no quiere un monolito modular ([consulta 1](../consultas-catedra.md)).

Restricciones:
- Somos tres personas y queda poco tiempo.
- identity y dispatch ya existían como servicios separados, con su contenedor, su base y sus tests en el CI.
- La variante G (flotas y zonas) y la asignación única (6.3) tienen que poder resolverse dentro de una transacción.
- La tarea pesada (6.6) es recibir 250 pings por segundo de 500 choferes y buscar candidatos al mismo tiempo, sin degradar el servicio.

## Opciones consideradas

1. **Monolito modular:** un solo proceso con módulos bien separados.
   - A favor: lo más simple de operar, y cada caso de uso puede ser una sola transacción.
   - En contra: la cátedra lo descartó expresamente.
2. **Los nueve servicios del plan original:** passengers, drivers, trips, payments, notifications, reservations, etc.
   - A favor: los límites ya estaban pensados.
   - En contra: son nueve contenedores, nueve bases y la comunicación entre ellos para tres personas. Varios módulos dejaron de existir en el enunciado nuevo (notifications con PDF, reservations), y el resto parte por la mitad transacciones que hoy son una: aceptar un viaje reserva al chofer; terminarlo lo libera y cobra.
3. **Tres servicios con otros límites:**
   - **Flotas dentro de identity**, junto a los usuarios. El filtro de candidatos por flota y zona, y el límite de choferes activos de la variante G, se consultan en cada asignación: dispatch tendría que llamar a identity en medio de la transacción del viaje, o copiar los datos y mantenerlos sincronizados.
   - **Tarifas y cobro como servicio aparte.** Finalizar un viaje libera al chofer y cobra; separados, hace falta una saga con compensación si el cobro falla.
   - **location dentro de dispatch.** Los 250 pings por segundo competirían por el mismo event loop que la asignación de viajes.
4. **identity, dispatch (viajes, flotas y tarifas) y location** (elegida).

## Decisión

Usamos tres servicios, el mínimo que pide la cátedra:

| Servicio | Qué resuelve | Por qué ese límite |
|---|---|---|
| **identity** (3001) | Registro, login, JWT RS256, refresh, logout, roles y JWKS | Ya existía. Los otros dos solo necesitan verificar tokens, y lo hacen con las claves públicas del JWKS, sin llamarlo en cada pedido |
| **dispatch** (3005) | Viajes (solicitud, ofertas, asignación única, estados), flotas (choferes, vehículos, zonas y límite de activos) y tarifas (tarifa y cobro simulado) | Comparten transacción. El filtro por flota y zona, la reserva y la liberación del chofer y el cobro al finalizar se resuelven en una sola base, sin transacciones distribuidas |
| **location** (3004) | Pings de ubicación, búsqueda de candidatos cercanos, historial y retención | Es la tarea pesada. En su propio proceso no le saca event loop a la asignación de viajes |

**Datos.** Un contenedor de Postgres con **una base y un usuario por servicio**, y `REVOKE ALL ... FROM PUBLIC`. Así ningún servicio puede leer las tablas de otro, aunque quiera. La cátedra permite compartir la base, pero separarla no costó trabajo y evita el acoplamiento por datos.

**Comunicación.** Solo por contratos (`packages/contracts`), nunca importando el dominio de otro servicio:

| De → a | Mecanismo | Estado |
|---|---|---|
| dispatch y location → identity | JWKS (`/.well-known/jwks.json`); `jose` guarda las claves en caché | Hecho |
| dispatch → location | HTTP interno `GET /interno/candidatos`, con timeout de 1 s y token de servicio. Si falla, la solicitud responde 503 y no se crea (falla cerrado) | Hecho (PR #9) |
| location → dispatch | Redis Pub/Sub, un canal por chofer, para el seguimiento en vivo | Pendiente (Fase B) |
| dispatch → navegador | SSE | Pendiente (Fase B) |

**Sin RabbitMQ.** Nadie lo exige y ningún código lo usaba; salió del Compose en el PR #9. La tabla `outbox` de dispatch se conserva como fuente de los eventos de tiempo real.

## Consecuencias

**Ganamos:**
- Cumplimos lo que pide la cátedra con el menor número de piezas.
- Las dos carreras centrales (6.3 y la variante G) se resuelven con transacciones de Postgres dentro de dispatch, sin coordinación entre servicios.
- **Aislamiento de fallas.** Con location caído, la solicitud de viaje responde 503 y no se crea, mientras el login sigue andando y dispatch sigue en `/ready` 200 (lo prueban `services/dispatch/tests/integracion/location.test.ts` y la prueba de punta a punta del PR #9). Si se cae identity, dispatch y location siguen verificando tokens con las claves que ya bajaron, pero solo mientras sigan en la caché de `jose` (`createRemoteJWKSet`, unos 10 minutos por defecto). No hay un test que lo pruebe.
- **La tarea pesada queda en otro proceso.** En la medición de 6.6, location sostuvo 250 pings por segundo con 1 CPU ([docs/mediciones.md](../mediciones.md)).

**Perdemos:**
- Hay llamadas de red donde antes había llamadas a funciones. Cada una necesita timeout, token de servicio, validación de la respuesta y una decisión sobre qué hacer si falla. Para eso está `crearClienteInterno` en `platform`.
- Son tres contenedores para levantar, monitorear y configurar. `npm run setup` y `npm run dev` lo esconden en desarrollo.

**Queda más difícil:**
- **dispatch es grande y tiene tres dueños:** Ivan (viajes), Agos (flotas) y Maxi (tarifas). Cada módulo va en su subcarpeta con las mismas capas, y el dominio sigue sin poder importar infraestructura (regla de ESLint).
- **Probar los bordes:** un test de dispatch no puede levantar location. Se prueba contra un location falso que respeta el contrato, más una prueba de punta a punta con los tres servicios.
- **Falta una medición:** el argumento de separar location para proteger la asignación es medible pero todavía no está medido. Hay que medir el lag del event loop de dispatch con el simulador de choferes corriendo; está pendiente en el plan.

## Qué nos haría cambiar de decisión

- **La cátedra pide más de tres servicios.** El siguiente candidato sería **tarifas y cobro**, con el cobro idempotente y una compensación si falla después de finalizar el viaje. Flotas no conviene separarlo, por la transacción de la variante G.
- **La medición del lag de dispatch no muestra diferencia** entre tener location aparte o adentro. El límite seguiría igual (lo exige la cátedra), pero el argumento de la defensa pasaría a ser el aislamiento de fallas, no el rendimiento.
- **Flotas pasa a tener una carga o un ciclo de vida propio**, por ejemplo un panel de administración con mucho tráfico. Se podría separar, a costa de copiar en dispatch los datos que el filtro de candidatos necesita.
- **La respuesta de la cátedra por escrito difiere de la verbal**, por ejemplo si acepta el monolito modular. Hay que pedirla por escrito (consulta 1).
