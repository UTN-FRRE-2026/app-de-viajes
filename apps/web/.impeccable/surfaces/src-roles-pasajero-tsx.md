---
version: 1
slug: "src-roles-pasajero-tsx"
primary_target: "src/roles/pasajero.tsx"
related_targets: ["src/roles/operador.tsx"]
---

# Pasajero (`/pasajero`) y operador (`/operador`)

Modo: Operate. Web de escritorio (notebook de la demo); que no se rompa en anchos chicos.

- **Audiencia y tarea.** El pasajero pide un viaje: elige origen y destino en el mapa o en lugares de la demo, ve la estimación, pide, espera la asignación, sigue el viaje en vivo, puede cancelar y ve el historial. El operador ve los viajes activos y el historial con búsqueda, y cancela con motivo.
- **Contenido real.** La API de dispatch: solicitudes, estimación, historial, panel, cancelar y eventos SSE. Los lugares de la demo están dentro de la zona CABA de `demo:flotas`.
- **Restricciones.** Las de PRODUCT.md: CSP estricta, mapas con Leaflet + teselas de OpenStreetMap (img-src), Idempotency-Key por operación, centavos.
- **Momento memorable.** Los pasos del viaje se prenden solos, con su hora, a medida que llegan los eventos.
- **Sin resolver.** Si el operador necesita algo más que viajes activos, historial con búsqueda y cancelación.

## Direction contract

THESIS: La pantalla del pasajero se organiza alrededor de la línea de tiempo del viaje. Cada evento que llega por SSE prende un paso con la hora en que llegó, así el tiempo real se ve sin explicarlo. Rechaza el arreglo de categoría de mapa a pantalla completa con una tarjeta flotante, donde el estado es una frase que cambia.

OWN-WORLD: El de la app, sin cambios: fondo #f4f6f8, tarjetas blancas con borde #dde2ea y radio 10 px, texto #1d2330, acento #1f6feb para el paso actual, #1a7f37 para lo hecho, pastillas redondeadas para conexión y estado, fuente del sistema, números tabulares. El mapa usa teselas de OSM sin filtros, con un punto oscuro de origen, uno azul de destino y uno verde para el chofer con halo.

STORY: El pasajero entiende en qué paso está su viaje y desde cuándo, cree que el sistema responde en vivo porque ve cada paso encenderse, y actúa: pide, espera o cancela. El operador ve qué viajes están vivos y los cancela con motivo.

FIRST VIEWPORT: Tres columnas bajo la barra. Izquierda, 300 px: la tarjeta «Tu viaje» con la pastilla de conexión y la línea Pedido, Chofer asignado, En camino, En viaje, Terminado, Cobrado; sin viaje, el formulario de pedido ocupa esa columna. Centro, flexible y del alto de la pantalla: el mapa. Derecha, 320 px: el chofer, la distancia, el origen y el destino, la estimación en grande, y Cancelar como acción secundaria. Pedir viaje es la acción principal del formulario.

FORM: Línea de tiempo como eje, número 2 en la lista ordenada (repartida por el sorteo). seed:b0a2b886ad9aa5ef

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
