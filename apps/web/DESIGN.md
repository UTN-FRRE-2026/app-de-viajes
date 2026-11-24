---
name: Viajes
description: Pantallas de demo de la plataforma de viajes (pasajero, chofer, operador, admin de flota); claras, planas y en vivo.
colors:
  fondo: "#f4f6f8"
  tarjeta: "#ffffff"
  texto: "#1d2330"
  suave: "#5b6475"
  acento: "#1f6feb"
  acento-texto: "#174ea6"
  acento-suave: "#e3ecfd"
  seleccion: "#cfe0fb"
  ok: "#1a7f37"
  ok-suave: "#e3f4e8"
  riel-hecho: "#a9d8b6"
  error: "#b42318"
  error-suave: "#fdecea"
  aviso-fondo: "#fff6e0"
  aviso-borde: "#f0d58c"
  borde: "#dde2ea"
  borde-control: "#c5ccd8"
  divisor: "#eef1f5"
  pastilla-neutra: "#e8edf5"
  gris-apagado: "#8a93a3"
typography:
  display:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
  headline:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1.4rem"
    fontWeight: 700
    lineHeight: 1.5
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1.15rem"
    fontWeight: 700
    lineHeight: 1.5
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  nota:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.9rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "tnum"
rounded:
  control: "6px"
  interior: "8px"
  tarjeta: "10px"
  pastilla: "999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.5rem"
  xxl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.acento}"
    textColor: "{colors.tarjeta}"
    rounded: "{rounded.control}"
    padding: "0.5rem 0.9rem"
  button-principal:
    backgroundColor: "{colors.acento}"
    textColor: "{colors.tarjeta}"
    rounded: "{rounded.control}"
    padding: "0.7rem 1rem"
    width: "100%"
  button-secundario:
    backgroundColor: "{colors.pastilla-neutra}"
    textColor: "{colors.texto}"
    rounded: "{rounded.control}"
    padding: "0.5rem 0.9rem"
  button-peligro:
    backgroundColor: "{colors.error}"
    textColor: "{colors.tarjeta}"
    rounded: "{rounded.control}"
    padding: "0.5rem 0.9rem"
  button-enlace:
    textColor: "{colors.acento}"
    padding: "0"
  input:
    backgroundColor: "{colors.tarjeta}"
    textColor: "{colors.texto}"
    rounded: "{rounded.control}"
    padding: "0.5rem 0.6rem"
  tarjeta:
    backgroundColor: "{colors.tarjeta}"
    textColor: "{colors.texto}"
    rounded: "{rounded.tarjeta}"
    padding: "1.5rem"
  pastilla:
    backgroundColor: "{colors.pastilla-neutra}"
    textColor: "{colors.suave}"
    typography: "{typography.label}"
    rounded: "{rounded.pastilla}"
    padding: "0.15rem 0.6rem"
  pastilla-en-marcha:
    backgroundColor: "{colors.acento-suave}"
    textColor: "{colors.acento-texto}"
  pastilla-ok:
    backgroundColor: "{colors.ok-suave}"
    textColor: "{colors.ok}"
  pastilla-error:
    backgroundColor: "{colors.error-suave}"
    textColor: "{colors.error}"
  aviso:
    backgroundColor: "{colors.aviso-fondo}"
    textColor: "{colors.texto}"
    rounded: "{rounded.tarjeta}"
    padding: "0.75rem 1rem"
  item-interior:
    backgroundColor: "{colors.tarjeta}"
    rounded: "{rounded.interior}"
    padding: "0.75rem"
---

# Design System: Viajes

## Overview

**Creative North Star: "El tablero de la demo"**

Un tablero claro y plano que se lee de un vistazo en la notebook de la defensa. Fondo gris frío, tarjetas blancas con un borde fino, un solo azul de acción y tres colores de estado (azul en marcha, verde hecho, rojo cortado). Nada compite con lo que el backend resuelve: la asignación y el seguimiento en vivo.

La identidad es la que el equipo ya usaba para chofer y admin de flota; pasajero y operador la extienden sin cambiarla. La densidad es la de una herramienta: textos del sistema, números tabulares, tablas sin adorno. El único gesto expresivo es la línea de tiempo del viaje, donde cada paso se prende cuando llega su evento.

Todo vive en una sola hoja, `src/estilos.css`, con los tokens base en `:root`. La CSP de la página no admite estilos en línea, así que esa hoja es la única fuente de verdad visual.

**Key Characteristics:**
- Plano: profundidad por borde y fondo, casi sin sombras.
- Un acento azul para la acción y el paso actual; el color de estado vive en pastillas.
- Fuente del sistema y números tabulares en todo lo que cambia (horas, montos, cuentas).
- Un solo movimiento: el paso de la línea de tiempo que se prende.

## Colors

Neutros fríos con un azul de acción y una tríada de estado; cada color de estado tiene su versión suave para fondos de pastilla.

### Primary
- **Azul de acción** (acento): botón primario, enlace activo de la barra, foco, destino en el mapa, paso actual de la línea de tiempo, recorrido punteado.
- **Azul tinta** (acento-texto): texto sobre azul suave (pastillas de viaje en marcha, paso actual, punto que se está marcando).
- **Azul suave** (acento-suave): fondo de la pastilla de viaje en marcha (buscando, asignado, en camino, en curso).

### Estado
- **Verde hecho** (ok) y su fondo (ok-suave): conexión en vivo, viaje completado, paso hecho, chofer en el mapa, resumen cobrado. El riel entre dos pasos hechos usa un verde lavado (riel-hecho).
- **Rojo cortado** (error) y su fondo (error-suave): errores, botón de peligro, conexión caída o reconectando, viajes cancelados o sin choferes, paso fallido.
- **Ámbar de aviso** (aviso-fondo, aviso-borde): la franja de aviso que pide una acción (oferta entrante, cupo, cancelar).

### Neutral
- **Fondo de página** (fondo), **tarjeta** blanca (tarjeta), **texto** casi negro azulado (texto) y **texto suave** (suave) para notas, encabezados de tabla y pasos pendientes.
- **Borde de tarjeta** (borde), **borde de control** (borde-control, inputs y selects), **divisor** interno (divisor) entre bloques de una tarjeta y filas de tabla.
- **Gris de pastilla** (pastilla-neutra): pastilla neutra y botón secundario. **Gris apagado** (gris-apagado): posición del chofer vieja en el mapa.

### Named Rules
**La Regla del Estado en Pastilla.** El estado de un viaje o de la conexión se dice con una pastilla redondeada de fondo suave y texto del color de estado: azul si sigue, verde si terminó bien, rojo si se cortó. No se inventan colores nuevos para estados nuevos; se elige uno de los tres.

**La Regla del Azul Único.** El azul de acción es el único color que invita a tocar. El verde y el rojo informan; el rojo solo es botón cuando la acción destruye algo (cancelar un viaje).

## Typography

**Body Font:** la fuente del sistema (system-ui, -apple-system, Segoe UI, Roboto, sans-serif), para todo.

**Character:** neutra y de herramienta; la jerarquía sale del tamaño y del peso, no de una segunda familia.

### Hierarchy
- **Display** (700, 2rem, 1.15, -0.01em, tabulares): solo el monto grande (estimación o tarifa final).
- **Headline** (700, 1.4rem): el h1 de cada tarjeta principal; en la columna angosta del pasajero baja a 1.25rem.
- **Title** (700, 1.15rem): h2 de las tarjetas de viaje; h3 del detalle a 1rem. La distancia del viaje usa 1.15rem a peso normal, tabular.
- **Body** (400, 1rem, 1.5): texto corriente; tablas a 0.93rem. Las etiquetas de formulario van a 500.
- **Nota** (400, 0.9rem, color suave): aclaraciones, motivos, ayuda.
- **Label** (400, 0.85rem): pastillas, horas y detalle de la línea de tiempo, encabezados de tabla (600, suave), códigos.

### Named Rules
**La Regla del Número Quieto.** Todo número que cambia en vivo o se compara en columna (horas, montos, distancias, cuentas regresivas, fechas e importes de tabla) lleva `font-variant-numeric: tabular-nums`.

## Layout

Una barra blanca arriba (borde inferior fino) y el contenido centrado debajo. Las pantallas de un solo flujo (login, chofer, flota) usan un contenedor de 960px; las pantallas anchas que marcan `.ancho` (pasajero, operador) se abren a 1360px. Login y estados de pantalla completa usan columnas angostas (380px y 480px).

El pasajero es una grilla de tres columnas: 300px (línea de tiempo o formulario de pedido), mapa flexible del alto de la pantalla (mínimo 560px) y 320px de detalle, con 1.25rem de separación. A 1180px pasa a dos columnas (el detalle baja a todo el ancho) y a 760px a una, con el mapa a 340px de alto. Las tablas se desplazan en horizontal por debajo de 900px.

El ritmo vertical es de 0.75rem dentro de las tarjetas y 1rem entre tarjetas; los bloques internos de una tarjeta se separan con una línea divisora y 0.75rem arriba, no con cajas anidadas.

## Elevation & Depth

Plano. La profundidad la dan el fondo gris frente a la tarjeta blanca y un borde de 1px; no hay sombras de reposo en tarjetas ni botones.

### Shadow Vocabulary
- **Flotante sobre el mapa** (`box-shadow: 0 4px 12px rgba(29, 35, 48, 0.16)`): solo la pastilla de ayuda que flota sobre el mapa, porque se apoya en teselas, no en el fondo.
- **Anillo del paso actual** (`box-shadow: 0 0 0 5px rgba(31, 111, 235, 0.18)`): halo del punto azul de la línea de tiempo.
- **Hundido** (`box-shadow: inset 0 0 0 1px` borde-control, fondo #dfe5ee): el botón «Cancelar» de la fila que está abierta en la tabla del operador.

### Named Rules
**La Regla del Borde, no la Sombra.** Una superficie se separa con borde de 1px y cambio de fondo. Una sombra aparece solo cuando algo flota sobre el mapa o marca un estado.

## Shapes

Esquinas suaves en cuatro escalones: 10px para tarjetas, avisos y el mapa; 8px para ítems dentro de una tarjeta (ofertas, choferes, estado vacío); 6px para controles (botones, inputs, selects); 999px para pastillas. Los puntos (línea de tiempo, marcadores del mapa, viñetas de origen y destino) son círculos. El estado vacío usa borde punteado (1px dashed borde-control).

## Components

### Buttons
- **Forma:** esquinas de control (6px), sin borde, fuente heredada.
- **Primario:** azul de acción con texto blanco (0.5rem 0.9rem). La acción principal de un formulario va a todo el ancho, más alta (0.7rem 1rem) y a 600.
- **Hover / Focus:** al pasar, `filter: brightness(0.94)`; el foco visible es un contorno de 2px azul a 2px de distancia, global. Deshabilitado: opacidad 0.6.
- **Secundario:** gris de pastilla con texto oscuro; para acciones que no avanzan el flujo (actualizar, volver, cancelar como segunda opción).
- **Peligro:** rojo con texto blanco; solo para confirmar una cancelación.
- **Enlace:** sin fondo ni relleno, azul subrayado; con `aria-pressed="true"` pasa a 600 sin subrayado (elegir en el mapa).
- En tablas y junto a códigos, el botón se achica (0.3rem 0.7rem, 0.88rem; 0.2rem 0.6rem, 0.85rem).

### Pastillas (conexión y estado)
- **Estilo:** 0.85rem, 0.15rem 0.6rem, radio 999px, fondo suave con texto de color; no se parten de línea dentro de un encabezado.
- **Estados:** neutra (gris), en marcha (azul), conectado / completado / sí (verde), reconectando / detenido / cancelado / sin choferes (rojo).

### Tarjetas / Contenedores
- **Esquinas:** 10px. **Fondo:** blanco. **Borde:** 1px borde. **Sombra:** ninguna. **Relleno:** 1.5rem, columna con 0.75rem de separación.
- **Encabezado:** fila con el título a la izquierda y la pastilla o la acción a la derecha.
- **Ítem interior:** 8px de radio, borde de 1px, 0.75rem de relleno; la oferta resaltada toma el borde azul y la vencida baja a opacidad 0.55. La tarjeta de resumen cobrado toma el borde verde.

### Aviso
Franja ámbar (fondo aviso-fondo, borde aviso-borde, 10px) con el texto a la izquierda y la acción a la derecha; en columnas angostas apila texto y botón.

### Inputs / Fields
- **Estilo:** borde-control de 1px, 6px, 0.5rem 0.6rem, fondo blanco. La etiqueta va arriba, a 500.
- **Foco:** el contorno azul global. Marcando un punto en el mapa, el select toma el borde azul y la leyenda el azul tinta.
- **Filtros:** select, campo y botones a la misma altura (2.5rem), alineados abajo.

### Tablas
Ancho completo, colapsadas, 0.93rem. Encabezado en 0.85rem, 600, suave, con borde inferior; filas separadas por el divisor y resaltadas en hover (#f8fafc). Números y fechas tabulares y sin cortar; los números a la derecha. La fila que se está cancelando y su fila de formulario toman un rosado muy suave (#fdf6f5).

### Navigation
Barra blanca con borde inferior; enlaces en texto suave sin subrayado; el activo en azul de acción y 600. Quién está conectado, en texto suave a la derecha.

### Mapa
Leaflet con teselas de OSM sin filtros, en un marco de 10px con borde. Origen: punto en el color del texto. Destino: punto azul. Chofer: punto verde con halo verde al 20%; gris apagado cuando la posición es vieja. Los puntos tienen 8px de radio (el halo 16px) y borde blanco de 3px. El recorrido es una línea azul punteada (6 8) al 55%.

### Línea de tiempo del viaje (componente insignia)
Lista vertical de pasos (Pedido, Chofer asignado, En camino, En viaje, Terminado, Cobrado), cada uno con un punto de 16px a la izquierda y un riel de 2px que lo une con el siguiente. Pendiente: punto blanco con borde gris y texto suave. Hecho: punto verde y riel verde lavado. Actual: punto azul con anillo y título en azul tinta. Fallo: punto y título rojos. Debajo de cada título, la hora y el detalle en label tabular.

**Movimiento (el único de la app):** al llegar el evento, el punto crece desde el centro (`prender`, 0.6s, cubic-bezier(0.16, 1, 0.3, 1)); el paso actual además suelta un anillo que se apaga (`prender-actual`, 0.9s). Con `prefers-reduced-motion: reduce` no hay animación.

**La Regla del Único Movimiento.** La línea de tiempo es lo único que se mueve. Ninguna otra superficie anima su entrada o sus cambios.

## Do's and Don'ts

### Do:
- **Do** escribir todo estilo en `src/estilos.css` con clases; la CSP de nginx rechaza `style=` y cualquier estilo o script en línea, y `npm run build` falla si los encuentra.
- **Do** usar los tokens de `:root` (`--fondo`, `--tarjeta`, `--texto`, `--suave`, `--acento`, `--error`, `--ok`) para todo color que ya tenga uno.
- **Do** decir el estado con una pastilla de los tres colores de estado, y la conexión en vivo siempre a la vista.
- **Do** separar bloques dentro de una tarjeta con el divisor de 1px y 0.75rem, no con otra caja.
- **Do** usar números tabulares en horas, montos, distancias y columnas numéricas.
- **Do** respetar `prefers-reduced-motion` en todo lo que se mueva.

### Don't:
- **Don't** usar `style=` ni estilos en línea, ni cargar fuentes, íconos o mapas de otro origen; solo las teselas de OpenStreetMap salen afuera.
- **Don't** agregar sombras a tarjetas o botones en reposo; la separación es borde y fondo.
- **Don't** animar nada fuera de la línea de tiempo del viaje.
- **Don't** usar el rojo para una acción que no destruye nada, ni el verde como botón.
