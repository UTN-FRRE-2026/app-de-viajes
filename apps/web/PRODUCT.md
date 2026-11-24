# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Cinco roles, cada uno con su sección (`src/roles/`):

- **Pasajero** (`/pasajero`): pide un viaje desde un origen a un destino, ve la estimación de la tarifa, espera la asignación y sigue el viaje en vivo (estado y posición del chofer) hasta el cobro. Consulta su historial.
- **Chofer** (`/chofer`, ya hecho): recibe ofertas que vencen a los 15 s, acepta, avanza el viaje (en camino, iniciado, finalizado) e informa su ubicación.
- **Operador** y **admin** (`/operador`): ven los viajes en curso y el historial con búsqueda, y cancelan un viaje con motivo.
- **Admin de flota** (`/flota`, ya hecho): gestiona los choferes y la activación de su flota.

Quien de verdad mira y evalúa las pantallas es la cátedra (UTN FRRE, TUP 2026): en la defensa, en el coloquio y con los flujos E2E de Playwright.

## Product Purpose

Plataforma de viajes del Grupo 7 (variante G: flotas y zonas operativas). El pasajero pide un viaje, dispatch se lo ofrece a choferes cercanos de flotas habilitadas en la zona del origen, exactamente uno lo gana, y el viaje se sigue en tiempo real hasta el cobro.

Es un proyecto académico. El peso está en el backend y en DevOps: tres microservicios, asignación única bajo concurrencia, tiempo real, idempotencia, carga con k6. El frontend es **mínimo**: la cátedra confirmó que alcanza. Las pantallas tienen que:

- mostrar con claridad en una demo en vivo lo que el backend resuelve, sobre todo la asignación y el seguimiento en tiempo real;
- poder recorrerse con Playwright (5 flujos, PLAN 5.3).

El éxito es que la demo se entienda a la primera, no la adopción de usuarios.

## Positioning

Lo que esta app muestra y otra no podría copiar tal cual:

- un solo chofer gana cada viaje aunque muchos acepten a la vez;
- las ofertas vencen;
- el estado y la posición llegan en vivo por SSE, sin recargar;
- cada operación con efecto es idempotente, así que un reintento no duplica nada.

Las pantallas hacen visibles esos mecanismos; no compiten con una app comercial de viajes.

## Operating Context

- **Web de escritorio para todos los roles**, por decisión del equipo (24/11): la referencia es el navegador de una notebook, que es donde se hace la demo. No se optimiza para el celular por ahora; que no se rompa en anchos chicos alcanza.
- Datos de prueba: los usuarios del seed de identity (`docs/identity.md`), y choferes y flotas de la demo (`npm run demo:flotas`).
- Se levanta con `npm run dev` y `npm run dev:web` (Vite en http://localhost:5173), o todo en contenedores detrás de nginx en http://localhost:8080.

## Capabilities and Constraints

- **Stack fijo:** React 19 + Vite + Zustand + react-router, workspace `apps/web`. Contrato y comportamiento del cliente en `docs/web.md`.
- **CSP estricta (nginx):** sin scripts ni estilos en línea, nunca `style=`, y ningún recurso de otro origen, ni fuentes ni mapas de un CDN. `npm run build` falla si encuentra código en línea (`scripts/revisar-csp.mjs`).
- **API del mismo origen:** `/api/identity`, `/api/viajes` y `/api/ubicacion`. Los POST con efecto llevan `Idempotency-Key`, la misma en cada reintento de una operación.
- **Tiempo real:** `GET /api/viajes/eventos` (SSE con `fetch` y `Authorization`, `src/tiempo-real/`). El pasajero recibe los eventos del viaje (`TripAssigned`, `DriverEnRoute`, `TripStarted`, `RideCompleted`, `RideCancelled`, `PaymentCaptured`…) y `DriverLocationUpdated`, y el chofer recibe `PassengerLocationUpdated`. Al reconectar, el estado se vuelve a pedir con `GET /solicitudes/:id`. Catálogo en `docs/eventos.md`.
- **Ubicación:** el pasajero puede informar su posición (`POST /ubicaciones/pasajero`), que solo ve su chofer asignado. Ya existen componentes compartidos (`src/ubicacion/`, `src/viaje/`).
- **Dinero en centavos enteros** (ARS). La estimación puede diferir de la tarifa final, y el motivo se informa.
- **Pendiente:** qué muestra exactamente la pantalla del operador más allá de los viajes, el historial con búsqueda y la cancelación con motivo.

## Brand Commitments

- No hay nombre comercial, logo ni paleta definidos: el título de la página es «Viajes». **Se puede proponer una identidad visual nueva para toda la app.** Si cambia el estilo de las pantallas de chofer (Maxi) y de admin de flota (Agos), hay que acordarlo con ellos.
- **Voz:** español rioplatense con voseo, directo y sin jerga técnica para el usuario final. Los errores muestran el `requestId` para buscarlo en el log.

## Evidence on Hand

- No hay testimonios, clientes, métricas de uso ni precios reales, y no se inventan.
- Lo que sí es real y se puede mostrar:
  - las mediciones de carga (`docs/mediciones.md`);
  - los tiempos hasta la asignación medidos con k6;
  - los usuarios del seed.

## Product Principles

1. **El estado del viaje se entiende de un vistazo:** en qué paso está, qué espera y qué puede hacer el usuario ahora.
2. **El tiempo real se ve:** los cambios que llegan por SSE se notan sin recargar, y una desconexión o reconexión se dice, no se esconde.
3. **Nada se duplica por un reintento:** las acciones con efecto se pueden repetir sin miedo, y la interfaz lo refleja (botón ocupado, resultado incierto con reintento).
4. **Mínimo y completo:** pocas pantallas, pero cada una cubre sus estados de carga, vacío, error y sin conexión, porque la demo y Playwright pasan por todos.
