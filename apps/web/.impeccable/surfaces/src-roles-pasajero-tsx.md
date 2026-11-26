---
version: 1
slug: "src-roles-pasajero-tsx"
primary_target: "src/roles/pasajero.tsx"
related_targets: ["src/roles/chofer.tsx","src/roles/operador.tsx","src/roles/flota.tsx"]
---

# Pasajero y chofer (celular primero), operador y flota (escritorio)

Modo: Operate. Celular primero para `/pasajero` y `/chofer` (instalable como PWA, demo en dos teléfonos); escritorio para `/operador` y `/flota` (pantalla grande en la defensa). Que se vea como una app real de viajes.

- **Audiencia y tarea.** El pasajero elige origen y destino, ve la estimación y la ruta real, pide, espera, sigue el auto en vivo, cancela y ve el historial. El chofer se pone disponible, recibe ofertas que vencen a los 15 s, acepta y avanza el viaje. Operador y flota administran.
- **Contenido real.** La API de dispatch (solicitudes, estimación, `GET /rutas`, historial, panel, SSE) y location. Lugares de la demo en Resistencia.
- **Restricciones.** CSP estricta (sin estilos ni scripts en línea; fuentes servidas desde el mismo origen), Leaflet + teselas OSM, Idempotency-Key. Los E2E buscan por rol y texto, y por `.oferta`, `.linea-tiempo .paso.actual/.hecho`, `.columna-detalle .monto/.distancia`, `li.chofer`.
- **Pedidos del usuario.** Los pasos del viaje alineados y sin pisarse. El auto con forma de auto, no un rectángulo. Primero eligió «Boleto de viaje» y después lo cambió por «Ruta nacional».
- **Momento memorable.** El cartel verde dice hacia dónde y en cuántos minutos; sobre la ruta del mapa, un mojón cuenta los kilómetros que faltan.

## Direction contract

THESIS: El viaje leído como una ruta argentina: un cartel verde de Vialidad con el destino y los minutos, mojones que cuentan los kilómetros y los pasos del viaje como señales que se encienden en fila. Rechaza la tarjeta flotante de categoría donde el estado es una frase que cambia.

OWN-WORLD: Verde ruta (#00563F) con filete blanco interior en la barra y los carteles, blanco chapa (#FFFFFF), negro asfalto (#1C1C1C) para el texto, ámbar de obra (#F2A900) para el paso actual, el tramo de aproximación y la línea de carril, gris verdoso (#E8EFEB) de fondo, rojo solo para anular y errores. Barlow (grotesca de señalización) en todo: condensada en mayúsculas para carteles y rótulos, cifras tabulares.

STORY: El pasajero mira el cartel y sabe hacia dónde va y cuánto falta; ve las señales encenderse en vivo y cree que el sistema responde; pide, espera, cancela o cobra. El chofer ve la oferta como un cartel con su cuenta regresiva y la acepta.

FIRST VIEWPORT: Celular: barra verde con la marca y la conexión; el mapa ocupa la mitad de arriba con la ruta real en verde con borde blanco, el auto ámbar visto desde arriba y un mojón blanco con los km; abajo, la hoja: el cartel verde (HACIA destino, minutos en grande a la derecha), DESDE → HASTA, casilleros de distancia y llegada, la fila de seis señales y, tras la línea de carril, la tarifa y la acción. Navegación abajo. Escritorio: mapa a la izquierda, hoja a la derecha.

FORM: Ruta nacional, señalética vial argentina; la elección IMPECCABLE’S PICK de la primera mano, tomada por el usuario después de probar el challenger. seed:fc9d8852fd33e969

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
