# ADR 0007 — Tiempo real con Server-Sent Events, alimentado por un outbox y Redis Pub/Sub

- **Estado:** aceptado
- **Fecha:** 2026-11-22. Registra lo que ya está en `main`: `GET /eventos` y la posición del chofer en vivo (#25).
- **Quiénes participaron:** Ivan (implementación y ADR) y Agos (dueña compartida del ADR en el reparto). Revisión: Agos y Maxi.
- **Servicio:** dispatch — PLAN 3.5 y 6.5 (tiempo real)

## Contexto

El pasajero tiene que ver en vivo cómo avanza su viaje: la asignación, el chofer en camino, el inicio, el fin, el cobro y la posición del chofer. El chofer tiene que recibir las ofertas, que vencen a los 15 s. Hoy esa información vive en la base de dispatch, y la posición, en location.

Hay que resolver dos cosas:

1. **Cómo llega al navegador.** El flujo es casi todo de servidor a cliente. Lo que el cliente manda (aceptar, cancelar, la ubicación del chofer) ya son pedidos HTTP con su autorización, su validación y su Idempotency-Key ([ADR 0010](0010-idempotencia.md)).
2. **Cómo no perder eventos.** Si dispatch hace `COMMIT` y después publica, una caída en el medio pierde el evento. Si publica antes, puede anunciar algo que después hace rollback. Además, dispatch puede correr con más de una instancia, y el cliente puede estar conectado a cualquiera.

Restricciones: todo pasa por el nginx del contenedor `web` ([docs/web.md](../web.md)); el token no puede ir en la URL, porque quedaría en los logs; cada usuario tiene que recibir solo lo suyo (5.x, autorización por recurso).

## Opciones consideradas

| Opción | A favor | En contra |
|---|---|---|
| **Polling** (`GET /solicitudes/:id` cada N segundos) | Lo más simple: no hay conexiones abiertas | Latencia de hasta N segundos, y carga proporcional a usuarios × frecuencia aunque no pase nada. Con ofertas de 15 s, un polling de 5 s se come un tercio del tiempo para aceptar |
| **Long polling** | Sin conexiones permanentes, latencia baja | Hay que escribir a mano la reposición, el corte y el reintento; cada evento cuesta un pedido nuevo |
| **WebSocket** | Bidireccional, latencia baja | No necesitamos el sentido cliente → servidor: lo que manda el cliente ya son pedidos HTTP. Hay que configurar el *upgrade* en nginx, inventar la autenticación (el navegador no deja mandar `Authorization` en el *handshake*: va en la URL o en el primer mensaje) y escribir un protocolo propio de reconexión y reposición. Socket.IO lo resuelve, pero agrega una dependencia grande y su propio protocolo |
| **Server-Sent Events** | HTTP común: pasa por nginx con `proxy_buffering off`, usa el mismo `Authorization` y el mismo helmet. El protocolo ya trae `id:`, `retry:` y `Last-Event-ID` para reconectar sin huecos | Un solo sentido. `EventSource` no manda encabezados (el frontend usa `fetch` y lee el stream). En HTTP/1.1, el navegador abre como mucho 6 conexiones por origen |

Para que los eventos no se pierdan, en las tres opciones con conexión abierta:

| Opción | Por qué no / por qué sí |
|---|---|
| Publicar en Redis después del `COMMIT` | Si el proceso muere entre los dos pasos, el evento se pierde |
| Un broker (RabbitMQ) | Lo sacamos del plan v2: es otro componente para operar, y Redis ya está ([ADR 0006](0006-tres-microservicios.md)) |
| **Outbox en la misma transacción + relay a Redis Pub/Sub** | El evento confirma con el cambio de estado o no existe. Redis Pub/Sub no guarda nada, pero no hace falta: el outbox es la fuente para reponer |

## Decisión

**SSE en `GET /eventos` de dispatch**, alimentado por **outbox + relay + Redis Pub/Sub**. Detalle completo en [docs/eventos.md](../eventos.md).

```
caso de uso ──(misma transacción)──▶ outbox ──relay cada 100 ms──▶ Redis Pub/Sub ──▶ GET /eventos (SSE)
                                       │      FOR UPDATE SKIP LOCKED   un canal por usuario     │
                                       └──────────── reposición con Last-Event-ID ◀──────────────┘
```

- **Outbox:** cada caso de uso escribe el evento en la misma transacción que el cambio de estado, con un `seq` creciente (es el `id:` del SSE) y sus destinatarios: el pasajero y el chofer del payload, nadie más.
- **Relay:** cada 100 ms toma un lote sin publicar con `FOR UPDATE SKIP LOCKED` (varias instancias no se pisan), publica en el canal de cada destinatario y lo marca. Entrega **al menos una vez**.
- **Stream:** el usuario sale del token, sin parámetros. Al conectar, primero se suscribe a su canal, después repone del outbox lo que tiene `seq` mayor que el `Last-Event-ID` (hasta 500) y recién ahí manda lo que llegó mientras tanto. Descarta los `seq` repetidos. Así la reconexión no deja huecos ni duplica.
- **Límites:** latido cada 15 s; 3 streams por usuario (429); el stream se cierra al vencer el token y al empezar el apagado; si Redis no responde, 503.
- **Posición del chofer:** location la publica en Redis; dispatch, que sabe qué viaje tiene cada chofer, la reenvía solo al pasajero del viaje activo. Va sin `id:`: vale la última, no se repone.
- **El cliente** usa `fetch` con `Authorization` y, al reconectar, además de mandar el `Last-Event-ID`, pide el estado actual con `GET /solicitudes/:id`. El stream avisa; la fuente de verdad sigue siendo la base.

## Consecuencias

- Un evento nunca se anuncia sin haber confirmado, ni se pierde por una caída: a lo sumo se publica dos veces, y el stream lo descarta.
- La garantía no depende de cuántas instancias de dispatch haya: el relay reparte con `SKIP LOCKED`, y cualquier instancia sirve el stream de cualquier usuario porque escucha su canal en Redis.
- La demora máxima de un evento es el intervalo del relay (100 ms) más la red. La posición del chofer no pasa por el outbox: llega con la latencia de Redis.
- Cada stream abierto ocupa una conexión HTTP y memoria en dispatch. Por eso el límite de 3 por usuario. Las suscripciones a la posición se comparten: una por chofer y por instancia.
- nginx necesita `proxy_buffering off` y un `proxy_read_timeout` mayor que el latido en esa ruta (hecho en el contenedor `web`).
- **El orden entre viajes distintos** del mismo usuario no está garantizado al reponer: un `seq` menor puede confirmar después de uno mayor. Dentro de un viaje sí, porque todo lo que lo cambia toma el lock de su fila. Por eso el cliente pide el estado al reconectar.
- **En HTTP/1.1, 6 conexiones por origen:** cada pestaña con el stream ocupa una. Con el límite de 3 streams por usuario no se llega, pero varias pestañas dejan menos conexiones para la API. Con TLS en el entorno publicado, nginx puede servir HTTP/2 y el límite deja de importar.

## Cómo se verifica

`tests/integracion/tiempo-real.test.ts`, `tests/integracion/posicion-chofer.test.ts`, `tests/externos/sse.test.ts` y `tests/concurrencia/relay.test.ts`, contra Postgres y Redis:

- el viaje de punta a punta en vivo, para el pasajero y el chofer, y cada uno ve solo lo suyo, también al reponer;
- la reconexión repone exactamente lo perdido, incluso lo que el relay todavía no publicó; un evento publicado dos veces llega una vez; lo que llega durante la reposición sale después y en orden;
- cuatro relays a la vez sobre 300 eventos publican cada uno exactamente una vez;
- el límite de streams, el token vencido, el apagado, el latido y el 503;
- las posiciones en vivo: la del chofer solo la ve su pasajero, y la del pasajero solo su chofer, mientras el viaje está activo, con una suscripción por canal.

Comprobado que fallan sin el `SKIP LOCKED` del relay, sin el filtro por destinatario de la reposición, sin el descarte de repetidos, sin la espera durante la reposición y sin cada regla de la posición del chofer ([docs/eventos.md](../eventos.md)). `npm run web:probar` comprueba que el stream pasa por nginx sin buffer.

## Qué nos haría cambiar de decisión

- **Necesitar el sentido cliente → servidor con latencia baja.** Por ejemplo, un chat entre pasajero y chofer, o que la ubicación del chofer viaje por la misma conexión a mucha frecuencia. Ahí WebSocket se justifica, y el outbox y la reposición siguen sirviendo igual.
- **Que el relay no alcance.** Si la medición muestra que el outbox crece más rápido de lo que el relay publica, o que la demora pasa de lo aceptable, se baja el intervalo, se agranda el lote o se cambia el sondeo por `LISTEN/NOTIFY` de Postgres para despertar al relay.
- **Muchas conexiones abiertas por instancia.** Si la memoria o los descriptores de dispatch se vuelven el límite, el stream se puede separar en un servicio propio que solo lea Redis y el outbox.
- **Necesitar orden total entre viajes al reponer.** Habría que numerar los eventos por usuario dentro de la transacción (un contador por usuario con lock), a cambio de serializar los eventos de un mismo usuario.
