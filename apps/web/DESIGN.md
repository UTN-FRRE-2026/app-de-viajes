---
name: Viajes
description: Pedí un viaje y seguilo en vivo, leído como una ruta argentina; cartel verde de Vialidad, mojones y señales que se encienden.
colors:
  verde: "#00563f"
  verde-2: "#00422f"
  verde-claro: "#e3efe9"
  ambar: "#f2a900"
  ambar-oscuro: "#c98a00"
  ambar-fondo: "#fff4d1"
  ambar-texto: "#6b4a00"
  rojo: "#c62828"
  rojo-2: "#a51f1f"
  rojo-fondo: "#fcecec"
  azul: "#1e5aa8"
  chapa: "#ffffff"
  fondo: "#e8efeb"
  asfalto: "#1c1c1c"
  suave: "#4c5852"
  apagado: "#5f6c65"
  filete: "#c3d0c8"
  filete-2: "#dde6e1"
typography:
  display:
    fontFamily: "'Barlow Condensed', 'Barlow', system-ui, sans-serif"
    fontSize: "2.9rem"
    fontWeight: 700
    lineHeight: 1
    fontFeature: "tnum"
  monto:
    fontFamily: "'Barlow Condensed', 'Barlow', system-ui, sans-serif"
    fontSize: "2.4rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.01em"
    fontFeature: "tnum"
  headline:
    fontFamily: "'Barlow Condensed', 'Barlow', system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "0.02em"
  title:
    fontFamily: "'Barlow Condensed', 'Barlow', system-ui, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "0.04em"
  title-sm:
    fontFamily: "'Barlow Condensed', 'Barlow', system-ui, sans-serif"
    fontSize: "1.15rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "0.05em"
  cifra:
    fontFamily: "'Barlow Condensed', 'Barlow', system-ui, sans-serif"
    fontSize: "1.4rem"
    fontWeight: 700
    lineHeight: 1.15
    fontFeature: "tnum"
  boton:
    fontFamily: "'Barlow Condensed', 'Barlow', system-ui, sans-serif"
    fontSize: "1.02rem"
    fontWeight: 700
    letterSpacing: "0.08em"
  senal:
    fontFamily: "'Barlow Condensed', 'Barlow', system-ui, sans-serif"
    fontSize: "0.86rem"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "0.05em"
  label:
    fontFamily: "'Barlow Condensed', 'Barlow', system-ui, sans-serif"
    fontSize: "0.8rem"
    fontWeight: 600
    letterSpacing: "0.11em"
  body:
    fontFamily: "'Barlow', system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  nota:
    fontFamily: "'Barlow', system-ui, sans-serif"
    fontSize: "0.93rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  chapita: "4px"
  senal: "6px"
  control: "8px"
  cartel: "10px"
  tarjeta: "12px"
  marco: "14px"
  hoja: "18px"
  pildora: "999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.25rem"
  xxl: "1.75rem"
components:
  button-primary:
    backgroundColor: "{colors.verde}"
    textColor: "{colors.chapa}"
    typography: "{typography.boton}"
    rounded: "{rounded.pildora}"
    padding: "0.95rem 1.2rem"
    width: "100%"
  button-primary-hover:
    backgroundColor: "{colors.verde-2}"
  button:
    backgroundColor: "{colors.verde}"
    textColor: "{colors.chapa}"
    typography: "{typography.boton}"
    rounded: "{rounded.control}"
    padding: "0.7rem 1.1rem"
    height: "2.75rem"
  button-secundario:
    backgroundColor: "{colors.chapa}"
    textColor: "{colors.asfalto}"
    rounded: "{rounded.control}"
    padding: "0.7rem 1.1rem"
  button-peligro:
    backgroundColor: "{colors.rojo}"
    textColor: "{colors.chapa}"
    rounded: "{rounded.control}"
    padding: "0.7rem 1.1rem"
  button-peligro-hover:
    backgroundColor: "{colors.rojo-2}"
  button-enlace:
    textColor: "{colors.verde}"
    padding: "0.15rem 0"
  input:
    backgroundColor: "{colors.chapa}"
    textColor: "{colors.asfalto}"
    rounded: "{rounded.control}"
    padding: "0.65rem 0.75rem"
    height: "2.75rem"
  cartel:
    backgroundColor: "{colors.verde}"
    textColor: "{colors.chapa}"
    typography: "{typography.headline}"
    rounded: "{rounded.cartel}"
    padding: "0.85rem 1.05rem 0.9rem"
  senal-hecha:
    backgroundColor: "{colors.verde}"
    textColor: "{colors.chapa}"
    typography: "{typography.senal}"
    rounded: "{rounded.senal}"
    padding: "0.45rem 0.45rem 0.5rem"
    height: "4.4rem"
  senal-actual:
    backgroundColor: "{colors.ambar}"
    textColor: "{colors.asfalto}"
    typography: "{typography.senal}"
    rounded: "{rounded.senal}"
  senal-pendiente:
    textColor: "{colors.apagado}"
    rounded: "{rounded.senal}"
  senal-fallo:
    backgroundColor: "{colors.chapa}"
    textColor: "{colors.rojo}"
    rounded: "{rounded.senal}"
  hoja:
    backgroundColor: "{colors.chapa}"
    textColor: "{colors.asfalto}"
    rounded: "{rounded.hoja}"
    padding: "1.1rem 1.25rem 1.75rem"
  tarjeta:
    backgroundColor: "{colors.chapa}"
    textColor: "{colors.asfalto}"
    rounded: "{rounded.tarjeta}"
    padding: "1.5rem"
  aviso:
    backgroundColor: "{colors.ambar-fondo}"
    textColor: "{colors.asfalto}"
    rounded: "{rounded.cartel}"
    padding: "0.85rem 1rem"
  patente:
    backgroundColor: "{colors.chapa}"
    textColor: "{colors.asfalto}"
    rounded: "{rounded.chapita}"
    padding: "0 0.4rem"
  mojon:
    backgroundColor: "{colors.chapa}"
    textColor: "{colors.asfalto}"
    width: "46px"
    height: "52px"
  etiqueta:
    textColor: "{colors.apagado}"
    typography: "{typography.label}"
    rounded: "{rounded.chapita}"
    padding: "0.12rem 0.45rem"
  etiqueta-en-marcha:
    backgroundColor: "{colors.ambar-fondo}"
    textColor: "{colors.ambar-texto}"
  etiqueta-hecho:
    backgroundColor: "{colors.verde-claro}"
    textColor: "{colors.verde}"
  etiqueta-cancelado:
    backgroundColor: "{colors.rojo-fondo}"
    textColor: "{colors.rojo}"
---

# Design System: Viajes

## Overview

**Creative North Star: "La ruta nacional"**

El viaje se lee como una ruta argentina. Un cartel verde de Vialidad dice hacia dónde vas y cuántos minutos faltan; un mojón blanco cuenta los kilómetros sobre el mapa; los pasos del viaje son señales en fila que se encienden cuando llega su evento: verde lo hecho, ámbar lo que pasa ahora. El estado no es una frase que cambia dentro de una tarjeta flotante: es una señal fija que se prende en su lugar.

El material es la chapa pintada de la señalética vial: verde ruta con un filete blanco interior a un paso del borde, blanco chapa, negro asfalto para el texto y ámbar de obra para lo que está en curso. Barlow, una grotesca de señalización, en todo; la versión condensada en mayúsculas para carteles, rótulos y botones, con cifras tabulares. El mapa queda en gris para que la ruta, el auto y el mojón lleven el color.

En el celular el mapa queda arriba y la hoja blanca sube por encima con el cartel, las señales, los datos y la acción; en pantalla grande, mapa a la izquierda y hoja al costado. Las pantallas de gestión (operador, flota, historial) usan el mismo material en versión de herramienta: tarjetas de chapa, tablas con filete verde y rótulos condensados.

Todo vive en `src/estilos.css`, con los tokens en `:root`. La CSP de la página no admite estilos ni scripts en línea, así que esa hoja es la única fuente de verdad visual.

**Key Characteristics:**
- Verde ruta con filete blanco interior: la marca de los carteles y de las señales hechas.
- Ámbar de obra para el ahora: el paso actual, el tramo de aproximación, la línea de carril, el auto.
- Señales en lugar fijo, que se encienden y nunca cambian de posición.
- Barlow Condensed en mayúsculas para todo lo que es cartel; cifras tabulares en todo lo que cambia.
- Mapa en gris; el color es de la ruta, el auto y el mojón.

## Colors

Una paleta de ruta: un verde dominante, un ámbar que marca el presente, neutros de chapa y asfalto sobre un gris verdoso, y el rojo reservado para anular y para los errores.

### Primary
- **Verde Ruta** (verde): la barra superior, el menú al pie del celular, los carteles, las señales hechas, el botón principal, la ruta en el mapa, el origen, los enlaces y el filete inferior de los encabezados de tabla. Es el color del sistema.
- **Verde Noche** (verde-2): el hover de los botones verdes y el fondo del cartel del logo.
- **Verde Lavado** (verde-claro): fondo del resumen cobrado, de la disponibilidad prendida del chofer y de la etiqueta de estado completado.

### Secondary
- **Ámbar de Obra** (ambar): el paso actual (señal ámbar con borde negro, como las de advertencia), la carrocería del auto visto desde arriba, la línea de carril discontinua que separa el cierre, la raya del enlace activo en la barra, el ícono activo del menú al pie y la barra de la oferta que se vacía.
- **Ámbar Oscuro** (ambar-oscuro): el tramo de aproximación punteado en el mapa y el borde de un punto que se está marcando.
- **Ámbar Fondo** (ambar-fondo) y **Ámbar Texto** (ambar-texto): avisos, punto que se está marcando, selección de texto, etiqueta de viaje en marcha y la hora del paso actual.

### Tertiary
- **Rojo Anular** (rojo, con rojo-2 al pasar y rojo-fondo de fondo): solo para anular y para los errores; el botón de peligro, la señal anulada, la fila que se está cancelando, el campo inválido, la luz trasera del auto y la oferta vencida.
- **Azul de Foco** (azul): solamente el contorno de foco y el borde del campo enfocado. No es un color de marca ni de acción.

### Neutral
- **Blanco Chapa** (chapa): la hoja, las tarjetas, los campos, el texto y el filete sobre verde, el mojón y la patente.
- **Gris Verdoso** (fondo): el fondo de la página y el hover del botón secundario.
- **Negro Asfalto** (asfalto): todo el texto, el borde del botón secundario, el destino en el mapa, el borde del mojón y de la patente, el filete interior de la señal ámbar.
- **Gris Pizarra** (suave): rótulos, notas, horas.
- **Gris Apagado** (apagado): señales pendientes, botones deshabilitados, cifras viejas.
- **Filete** (filete) y **Filete Claro** (filete-2): bordes de tarjeta, hoja y casilleros, divisores internos y filas de tabla.

Valores literales que no son token y viven en la hoja: el borde de los campos (#8e9c94), el guión de la señal pendiente (#a9b9b0), el hover de fila de tabla (#f4f8f6) y los puntos de la conexión en vivo (#7be0a8 conectado, ámbar reconectando, #ff7a7a detenido).

### Named Rules
**La Regla del Ámbar es Ahora.** El ámbar marca solo lo que está pasando en este momento: el paso actual, el tramo que el auto está recorriendo, el auto y la línea de carril antes de la acción. Nada terminado ni pendiente es ámbar.

**La Regla del Rojo que Anula.** El rojo aparece solo cuando algo se anula o falla. Nunca decora ni marca un estado normal.

**La Regla del Mapa Gris.** Las teselas van filtradas a gris (`grayscale(0.85) contrast(0.95) brightness(1.04)`); el color del mapa lo llevan la ruta verde con borde blanco, el auto ámbar y el mojón.

## Typography

**Display Font:** Barlow Condensed (con Barlow y system-ui de respaldo)
**Body Font:** Barlow (con system-ui de respaldo)

**Character:** una grotesca de señalización vial en dos anchos. La condensada en mayúsculas, con interletra abierta, es la voz de los carteles; la normal lleva el texto corriente, las notas y los campos. Ambas se sirven del mismo origen con @fontsource (Barlow 400/500/600, Barlow Condensed 600/700).

### Hierarchy
- **Display** (700, 2.9rem, 1, tabular): los minutos grandes a la derecha del cartel.
- **Monto** (700, 2.4rem, 1, tabular; 1.75rem en el cierre fijo): la tarifa estimada o final.
- **Headline** (700, 1.75rem, 1.02, mayúsculas; 1.55rem en el celular): el lugar del cartel.
- **Title** (700, 1.6rem, mayúsculas): h1. El h1 del cartel baja a 1.25rem con 0.07em. h2 a 1.15rem (0.05em) y h3 a 0.98rem (0.07em), siempre condensados y en mayúsculas.
- **Cifra** (700, 1.4rem, tabular): los valores de los casilleros. DESDE y HASTA van a 1.3rem, condensados en mayúsculas.
- **Botón** (700, 1.02rem, 0.08em, mayúsculas; 1.12rem en el principal).
- **Señal** (700, 0.86rem, 1.08, 0.05em, mayúsculas): el texto dentro de cada señal.
- **Label** (600, 0.8rem, 0.11em, mayúsculas, gris pizarra): rótulos de casilleros, leyendas, encabezados de tabla.
- **Body** (400, 1rem, 1.5): texto corriente. Las etiquetas de formulario van a 600 y 0.95rem.
- **Nota** (400, 0.93rem, gris pizarra): aclaraciones y ayuda.

### Named Rules
**La Regla del Cartel Condensado.** Todo lo que se lee como cartel (títulos, lugares, rótulos, botones, señales, el menú, el mojón, la patente) va en Barlow Condensed, mayúsculas e interletra abierta. El texto que se lee como frase va en Barlow normal y en caja baja.

**La Regla del Número Quieto.** Toda cifra que cambia en vivo o se compara en columna (minutos, horas, montos, distancias, cuentas regresivas, patentes, números de viaje, fechas e importes de tabla) lleva `font-variant-numeric: tabular-nums`.

## Layout

Una barra verde fija arriba (3.5rem; 3.25rem en el celular). Por debajo de 720px el menú baja al pie como una franja verde de 4rem con ícono y rótulo, respetando el área segura; quién está conectado se oculta y el texto de «Salir» queda solo para lectores.

**Pasajero y chofer** son mapa y hoja. En el celular el mapa queda fijo arriba (entre 16rem y 30rem, 44dvh) y la hoja blanca se superpone 1.25rem, con esquinas superiores de 18px. Con una oferta entrante, el mapa del chofer se achica (11rem a 17rem). Desde 960px es una grilla: mapa flexible a la izquierda y hoja de 27.5rem a la derecha, 1.25rem de separación y de margen, a la altura de la pantalla, cada uno en un marco de 14px con filete.

**La hoja** se ordena de arriba abajo: el cartel (con 0.75rem de margen), luego el cuerpo con 1.1rem entre bloques: las seis señales en grilla de 3 columnas (0.6rem por 0.5rem), los casilleros, DESDE → HASTA y el cierre. Mientras se pide, el cierre queda fijo abajo en una fila compacta: el importe a la izquierda y «Pedir viaje» a la derecha.

**Las pantallas de gestión** van en un contenedor de 960px; las que marcan `.ancho` (operador) se abren a 1360px. Login y estados de pantalla completa usan columnas de 400px y 480px. Las tablas se desplazan en horizontal por debajo de 900px.

El ritmo es de 0.75rem a 1rem dentro de un bloque y 1.1rem entre bloques de la hoja. Los bloques internos se separan con un filete, no con otra caja.

## Elevation & Depth

Casi plano. La profundidad la da la chapa blanca sobre el gris verdoso y un filete de 1px. El filete blanco interior de los carteles y las señales es un `box-shadow` inset doble, no una sombra: es pintura.

### Shadow Vocabulary
- **Filete de cartel** (`box-shadow: inset 0 0 0 4px <verde>, inset 0 0 0 6px #fff`): el cartel. La señal hecha usa 2.5px y 4px; la señal actual, 2.5px de ámbar y 4.5px de asfalto. La barra superior lleva el filete solo abajo (`inset 0 -5px 0 <verde>, inset 0 -6.5px 0 rgba(255,255,255,0.85)`).
- **Sombra de ruta** (`--sombra: 0 6px 20px rgba(0, 40, 28, 0.16)`): lo que flota sobre el mapa o se apoya en él: la oferta del chofer, los controles de zoom, la ayuda del mapa y la hoja en pantalla grande.
- **Hoja que sube** (`0 -6px 20px rgba(0, 40, 28, 0.18)`): la hoja del celular sobre el mapa. El cierre fijo usa `0 -8px 18px rgba(0, 40, 28, 0.1)` y el menú al pie `0 -4px 16px rgba(0, 30, 20, 0.22)`.
- **Botón principal** (`0 3px 10px rgba(0, 66, 47, 0.22)`): la única sombra de un control en reposo.
- **Mojón** (`0 3px 8px rgba(0, 0, 0, 0.25)`): el poste parado sobre el mapa.

### Named Rules
**La Regla del Filete es del Cartel.** El filete blanco interior pertenece a la señalética: la barra, los carteles y las señales hechas. Ningún botón lo lleva, para que un paso hecho nunca se lea como un botón.

## Shapes

Chapas de esquinas apenas redondeadas, en escalones: 4px para lo chico (patente, etiqueta de estado), 6px para las señales, 8px para botones comunes y campos, 10px para carteles, avisos y casillas de punto, 12px para tarjetas y paneles, 14px para los marcos de mapa y hoja en pantalla grande y 18px para la hoja del celular (solo arriba). La píldora (999px) es para la acción principal, la conexión en vivo y la ayuda del mapa.

El mojón tiene su silueta propia: 46 por 52px, cabeza redondeada (16px arriba, 4px abajo), borde asfalto de 2px. El origen es un círculo y el destino un cuadrado de esquinas mínimas (2px) en las leyendas. Las señales pendientes tienen borde discontinuo; la línea de carril es un guión ámbar de 1.25rem con 0.75rem de hueco y 3px de alto.

Los íconos son SVG dibujados a mano en una grilla de 24px, trazo `currentColor` de 1.75 con puntas y uniones redondeadas (2.25 en el cartel, 2 en las señales). El auto es un SVG cenital propio de 40px que gira con el rumbo.

## Components

### Buttons
Carteles que se tocan: condensados, en mayúsculas, sólidos.
- **Shape:** esquinas de control (8px), borde de 2px del mismo color del fondo, mínimo 2.75rem de alto.
- **Principal:** píldora verde maciza a todo el ancho (0.95rem 1.2rem, 1.12rem), con la sombra del botón principal y **sin filete blanco**. En el cierre fijo pasa a ancho automático.
- **Hover / Active / Focus:** al pasar, verde noche; al apretar baja 1px; el foco es el contorno azul de 2.5px a 2px, global (blanco dentro de la barra). Deshabilitado: filete claro con texto apagado.
- **Secundario:** chapa blanca con borde y texto asfalto; al pasar, fondo gris verdoso.
- **Peligro:** rojo con texto blanco; solo para anular un viaje.
- **Enlace:** sin caja, Barlow 600 a 0.93rem, verde subrayado; con `aria-pressed="true"` pasa a ámbar texto sin subrayado (marcar en el mapa).
- **Salir:** contorno blanco a media opacidad sobre la barra.

### Cartel (componente insignia)
El cartel verde de Vialidad. Fondo verde ruta, texto blanco, 10px, filete blanco interior. Arriba, el h1 condensado, el número de viaje tabular y la conexión en vivo a la derecha; un filete blanco al 55% lo separa de la línea grande: el pictograma (flecha hacia, pin de encuentro, bandera de llegada, reloj), el lugar en headline y los minutos en display a la derecha. La palabra que dice el pictograma («Hacia», «Tu chofer te busca en») existe solo para lectores. La oferta del chofer es un cartel con la sombra de ruta, la línea «hacia» y una cuenta regresiva con una barra ámbar que se vacía (roja al final). La bandera de llegada sin cifra también dice que el auto llegó al origen: «Tu chofer llegó» para el pasajero y «Llegaste · esperá al pasajero» para el chofer, en la línea chica bajo el lugar.

### Señales (línea de tiempo)
Seis pasos en lugar fijo, grilla de 3×2. Cada señal tiene un pictograma, el nombre en mayúsculas y debajo la hora tabular. Pendiente: borde discontinuo y texto apagado. Hecha: verde con filete blanco. Actual: ámbar con filete asfalto, como una señal de advertencia; su hora en ámbar texto. En rojo (chapa con borde rojo de 3px): la señal final de un viaje cancelado o sin choferes, con la palabra «Anulado» arriba; y la de «Cobrado» si se rechazó el cobro, sin «Anulado» (el viaje terminó) y con el motivo debajo en rojo. Al encenderse, la señal entra un poco grande y tenue y asienta (`encender`, 0.45s, `cubic-bezier(0.16, 1, 0.3, 1)`, 40ms de escalonado por paso). Con `prefers-reduced-motion: reduce` no se anima.

### Casilleros
Datos con su rótulo en una grilla de columnas de 6.5rem mínimo, entre filetes arriba y abajo y separados por filete claro vertical. El valor va en cifra tabular. Las distancias salen de la ruta real, igual que el mojón. Si la posición es vieja, las cifras pasan a apagado.

### Cierre
La línea de carril ámbar discontinua y, debajo, el importe (rótulo + monto) y la acción principal. Mientras se pide, queda fijo al pie de la hoja sobre chapa blanca.

### Mapa
Leaflet con teselas de OSM en gris. La ruta real es una línea verde de 5.5px sobre un borde blanco de 10px, de puntas redondeadas; si todavía es recta (sin ruta), va punteada. El tramo de aproximación del chofer al origen es ámbar oscuro punteado (1 9). El origen es un punto verde y el destino uno asfalto, con borde blanco de 3px; la persona es un punto blanco con borde asfalto y halo. El auto es ámbar, visto desde arriba, con luces y sombra; gira con transición de 0.35s y pasa a gris cuando la posición es vieja. La ayuda del mapa es una píldora verde centrada abajo.

### Mojón
El poste blanco de los kilómetros: el número en condensada tabular de 1.15rem y la unidad abajo en 0.68rem. Se pone solo en tramos de 800 m o más, en el punto medio del tramo medido por distancia (no por cantidad de puntos), sobre la aproximación si existe o si no sobre la ruta. Si en ese punto quedaría a menos de 70px de un pin, de la persona o del auto, se prueba al 35 % y al 65 % del tramo; si tampoco hay lugar, no va. Por eso la distancia que falta también va en el cartel, chica bajo el lugar («a 649 m»): se ve aunque el mojón no se dibuje.

### Inputs / Fields
- **Style:** chapa blanca, borde de 1.5px gris verdoso medio, 8px, 0.65rem 0.75rem, Barlow 500. La etiqueta va arriba, a 600.
- **Hover / Focus:** al pasar, borde asfalto; con foco, borde y contorno azul.
- **Error:** `aria-invalid` lleva el borde rojo.
- **Casillas de punto (DESDE / HASTA):** un fieldset con filete y 10px; la leyenda lleva un círculo verde (origen) o un cuadrado asfalto (destino). Mientras se marca en el mapa, la casilla pasa a ámbar fondo con borde ámbar oscuro.

### Tarjetas / Contenedores
- **Corner Style:** 12px (tarjeta), 18px arriba (hoja).
- **Background:** chapa blanca.
- **Border:** filete de 1px; el h2 de la tarjeta lleva un filete claro debajo.
- **Internal Padding:** 1.5rem (1.15rem en el celular), con 0.9rem entre bloques.
- **Variantes:** la disponibilidad del chofer prendida toma borde verde y fondo verde lavado; el resumen cobrado, borde verde de 2px y fondo verde lavado; el aviso, ámbar fondo con borde ámbar.

### Listas y tablas
Las tablas van a ancho completo, encabezado en label sobre un filete verde de 2px, filas separadas por filete claro, números tabulares a la derecha. La fila que se está cancelando y su formulario toman rojo fondo; su botón «Cancelar» queda hundido. Los choferes de la flota son filas de una lista (datos y marcas a la izquierda, la acción al final), no tarjetas anidadas. Las etiquetas de estado (4px, label, borde y fondo del color del estado: ámbar en marcha, verde hecho, rojo cancelado) viven solo en tablas y listas de gestión.

### Patente
La patente del auto como una chapita: blanco, borde asfalto de 1.5px, 4px, condensada 700 con 0.1em de interletra.

### Navigation
Barra verde con el logo (un cartel verde con filete, flecha blanca y raya ámbar) y la marca en condensada. Enlaces en condensada 600, blanco al 76%; al pasar, blanco; el activo lleva una raya ámbar de 3px abajo. En el celular el menú es una franja al pie con ícono arriba y rótulo abajo; el ícono activo se pinta de ámbar. La conexión en vivo es una píldora blanca al 14% con un punto de color.

## Do's and Don'ts

### Do:
- **Do** escribir todo estilo en `src/estilos.css` con clases y tokens de `:root`; la CSP rechaza `style=` y cualquier estilo o script en línea, y `npm run build` falla si los encuentra.
- **Do** servir las fuentes desde el mismo origen con @fontsource (Barlow y Barlow Condensed); nada de CDN.
- **Do** decir el estado del viaje con la señal ámbar en su lugar fijo de la grilla.
- **Do** usar el filete blanco interior solo en la barra, los carteles y las señales hechas.
- **Do** hacer la acción principal como una píldora verde maciza, sin filete.
- **Do** decir la dirección del cartel con un pictograma y dejar la palabra solo para lectores (`.solo-lector`).
- **Do** sacar las distancias de los casilleros de la ruta real, igual que el mojón, y poner el mojón solo en tramos de 800 m o más, en el punto medio por distancia.
- **Do** dejar las teselas en gris para que la ruta, el auto y el mojón lleven el color.
- **Do** usar cifras tabulares en minutos, horas, montos, distancias, cuentas y columnas numéricas.
- **Do** respetar `prefers-reduced-motion` en todo lo que se mueva (las señales al encenderse y el giro del auto).

### Don't:
- **Don't** poner el filete blanco de cartel en un botón: un paso hecho no se tiene que leer como un botón.
- **Don't** poner un rótulo o «kicker» encima del lugar del cartel; el pictograma ya lo dice.
- **Don't** usar pastillas de estado en las vistas del viaje (pasajero y chofer); la señal ámbar es el estado.
- **Don't** usar el ámbar para algo terminado o pendiente, ni el rojo para algo que no se anula o falla.
- **Don't** usar el azul fuera del foco.
- **Don't** anidar tarjetas: los choferes de la flota son filas de lista y los bloques de la hoja se separan con filete.
- **Don't** mover una señal de lugar ni reemplazar una por otra cuando cambia el estado.
- **Don't** usar íconos de fuente, emojis ni librerías de íconos; los pictogramas son SVG propios de trazo redondeado.
