# Eventos y comunicación entre servicios

Los servicios no se llaman entre sí para avisar que algo pasó: **publican un evento**, RabbitMQ lo guarda y cada servicio interesado lo procesa cuando puede. El que publica no sabe quién escucha.

## Topología en RabbitMQ

```
 dispatch ──publica──▶ [ EXCHANGE viajes.events ] ──binding──▶ [ cola trips.eventos ]          ──▶ trips
                         (tipo topic)            ├─binding──▶ [ cola notifications.eventos ]  ──▶ notifications
                                                 └─binding──▶ [ cola realtime.eventos ]       ──▶ realtime
```

- **Exchange `viajes.events` (topic):** recibe los mensajes y los reparte; no los guarda.
- **Routing key:** `<servicio>.<entidad>.<hecho>`, por ejemplo `dispatch.trip.assigned`.
- **Una cola por servicio consumidor:** si notifications está caído, sus mensajes se acumulan en su cola y el resto sigue procesando.
- **Binding:** el patrón que cada cola quiere recibir, con comodines: `dispatch.trip.*`, `*.trip.#`.

### Ejemplo: un chofer acepta un viaje

1. **dispatch** asigna el viaje (transacción con `FOR UPDATE`, ver [ADR 0004](adr/0004-asignacion-unica.md)) y publica `TripAssigned`.
2. **trips** crea el viaje en estado `ASIGNADO`.
3. **realtime** avisa por SSE al pasajero («tu chofer viene») y al chofer.
4. **notifications** registra o envía la notificación.

Cuando el viaje termina, trips publica `TripFinished`: dispatch libera al chofer (`liberarChofer`) y payments cobra.

## Eventos (RabbitMQ) o llamada HTTP

| Eventos, cuando... | HTTP, cuando... |
|---|---|
| Se avisa algo que **ya pasó** | Se necesita **una respuesta ya** para seguir |
| No importa quién reacciona ni cuándo | El usuario está esperando el resultado |
| Varios servicios reaccionan al mismo hecho | Es una consulta puntual (ej. estimación de tarifa) |

**Proyecciones:** dispatch mantiene una copia de lectura (chofer → flota → zonas habilitadas) alimentada por los eventos de drivers. Así no hace falta llamar a drivers por HTTP en el camino caliente de la búsqueda de candidatos, y dispatch sigue funcionando aunque drivers esté caído.

## Garantías: outbox + inbox

> La entrega exactamente una vez no existe en sistemas distribuidos. Lo que logramos es **entrega al menos una vez** (con el outbox) más **procesamiento idempotente** (con el inbox), y el efecto final es equivalente a exactamente una vez.

### Outbox: no perder eventos

El código ingenuo hace `COMMIT` y después publica en Rabbit. Si el proceso muere en el medio, el evento se pierde. Invertir el orden tampoco sirve: se anunciaría algo que después no se confirmó.

Por eso el evento se escribe en la tabla `outbox` **en la misma transacción** que el cambio de estado. Un *relay* aparte lee los eventos con `published_at IS NULL`, los publica y los marca como publicados. Si el relay muere después de publicar y antes de marcar, el evento se publica dos veces, y de eso se encarga el inbox.

### Inbox: no procesar dos veces

Cada consumidor tiene una tabla `inbox` con `message_id` único, y en la misma transacción que procesa el evento hace:

```sql
INSERT INTO inbox (message_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING message_id;
-- 0 filas → ya se procesó: ack y nada más
-- 1 fila  → procesar (ej. borrar driver_active_assignment)
COMMIT;  -- recién después, ack a Rabbit
```

### Reglas para los consumidores

- **Ack manual, después del `COMMIT`**, nunca antes.
- **Reintentos con espera creciente.** Después de N fallos el mensaje va a `<cola>.dlq` para revisarlo a mano, así no bloquea al resto.
- **No asumir orden** entre eventos.
- **Validar el payload** con el esquema de `packages/contracts`, igual que un body HTTP.
- **Propagar `x-request-id`** en los headers del mensaje, para seguir un viaje de punta a punta en los logs.

## Catálogo

Los esquemas están en [`packages/contracts/src/dispatch.ts`](../packages/contracts/src/dispatch.ts) (`EventosDispatch`).

### dispatch (implementados en el outbox)

| Evento | Cuándo | Payload | Consumidores previstos |
|---|---|---|---|
| `RideRequested` | Se crea una solicitud | `solicitudId, pasajeroId, origen, destino` | notifications |
| `OfferCreated` | Se ofrece el viaje a un chofer | `ofertaId, solicitudId, choferId, venceEn` | realtime (push al chofer) |
| `OfferExpired` | Vence una oferta sin respuesta | `ofertaId, solicitudId, choferId` | realtime |
| `TripAssigned` | Un chofer gana la asignación | `solicitudId, pasajeroId, choferId, origen, destino` | trips, realtime, notifications |
| `RideCancelled` | El pasajero cancela | `solicitudId, pasajeroId, choferId \| null, estabaAsignada` | trips, realtime, notifications |
| `NoDriversFound` | No quedan candidatos | `solicitudId, pasajeroId` | realtime, notifications |
| `RideCompleted` | Se libera al chofer al terminar el viaje | `solicitudId, choferId` | — |

### Previstos en otros servicios

| Evento | Productor | Consumidores |
|---|---|---|
| `TripFinished`, `TripCancelled` | trips | dispatch (`liberarChofer`), payments, notifications |
| `DriverEnabled`, `FleetZoneEnabled`, ... | drivers | dispatch (proyección) |
| `PaymentCaptured`, `RefundIssued` | payments | trips, notifications |

## Pendiente (Fase 1)

- Relay del outbox hacia `viajes.events`.
- Consumidor con inbox en dispatch para `TripFinished`/`TripCancelled`.
- Declaración de exchange, colas, bindings y DLQ al arrancar cada servicio.
