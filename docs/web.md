# Contenedor web (nginx)

El único punto de entrada (PLAN 2): sirve el frontend y hace de reverse proxy a los tres servicios. Archivos en `infra/web/`: la configuración (`default.conf`) y el `Dockerfile`, que también compila el frontend (`apps/web`, ver [El frontend](#el-frontend-appsweb)).

```
navegador ──▶ web :8080 ─┬─ /                → el frontend (index.html para cualquier ruta del frontend)
                         ├─ /api/identity/   → identity :3001
                         ├─ /api/viajes/     → dispatch :3005   (/api/viajes/eventos: SSE sin buffer)
                         └─ /api/ubicacion/  → location :3004
```

Se levanta con el resto: `docker compose up -d --build` y después http://localhost:8080 (`WEB_PUERTO` en el `.env`).

## El frontend (`apps/web`)

React + Vite + Zustand (PLAN 5.2), instalable como PWA ([Diseño y PWA](#diseño-y-pwa)). Es un workspace más: `npm run dev:web` lo levanta en http://localhost:5173 con el mismo enrutamiento que nginx (el proxy de Vite manda `/api/identity`, `/api/viajes` y `/api/ubicacion` a 3001, 3005 y 3004), y `npm run build -w @viajes/web` lo compila. El `Dockerfile` de `web` lo compila en una etapa propia y nginx sirve `dist/`. Los archivos de `/assets/` llevan hash y se cachean para siempre; la página sigue con `no-cache` y la CSP.

**CSP.** El build no tiene scripts ni estilos en línea: un `index.html` mínimo, los estilos en archivos `.css` (nunca `style=`) y `assetsInlineLimit: 0`, para que nada quede embebido como `data:`. `npm run build` lo comprueba (`apps/web/scripts/revisar-csp.mjs`) y falla si encuentra código en línea.

**Sesión** (`src/sesion/store.ts`, Zustand):
- el access token vive **solo en memoria**; el `refreshToken` y el usuario se guardan en **`sessionStorage`**, que se pierde al cerrar la pestaña;
- al abrir la página, si quedó un refresh, se recupera la sesión **antes de redirigir**: mientras tanto el estado es `cargando` y ninguna ruta manda al login;
- **una sola renovación a la vez:** si varios pedidos reciben 401 juntos, comparten el mismo `POST /refresh`. Identity rota el refresh en cada uso y, si ve uno ya usado, revoca la sesión entera;
- el refresh **no se reintenta:** si no es válido, la sesión termina;
- al **cerrar sesión**, primero se limpia el estado (eso cambia la «época» de la sesión) y después se avisa a identity. Una renovación que vuelva después se descarta.

**Cliente HTTP** (`src/api/cliente.ts`):
- `pedir(metodo, '/viajes/solicitudes', { cuerpo, clave })` usa rutas relativas (`/api` + la ruta), agrega el `Authorization` y normaliza los errores en `ErrorApi`, con el formato `{error:{code,message,requestId}}` de los servicios. Si no hubo respuesta, el código es `RED`;
- con un **401**, una sola vez más: con el token vigente, si otro pedido ya lo renovó mientras este viajaba (un 401 que llegó tarde), o renovando. **El reintento conserva la misma `Idempotency-Key`.** Si igual da 401, la sesión termina;
- **`clave`:** las rutas que exigen `Idempotency-Key` son los POST y PUT con efecto de dispatch y `POST /identity/registro`. Se genera una por operación (`nuevaClave()`, o `ClavesDeOperacion` de `src/api/operacion.ts`) y se reutiliza en cualquier reintento de esa misma operación, también cuando el resultado fue incierto (ver [La pantalla del chofer](#la-pantalla-del-chofer-chofer));
- **el login** va por su cuenta (`src/sesion/login.ts`): un 401 ahí es «email o contraseña incorrectos», no una sesión vencida. El 429 del límite de intentos muestra cuándo volver a probar.

**Errores.** `MensajeError` muestra el mensaje y el `requestId` (para buscarlo en el log), y ofrece «Reintentar» con red caída o 5xx. Un `ErrorBoundary` en el layout y el `errorElement` del router contienen las fallas al dibujar.

**Pantallas por rol.**

| Rol | Sección |
|---|---|
| `pasajero` | `/pasajero` |
| `chofer` | `/chofer` |
| `operador` y `admin` | `/operador` (el `admin` suma `/operador/choferes`) |
| `admin_flota` | `/flota` |

Cada rol tiene su archivo en `src/roles/` (`pasajero.tsx`, `chofer.tsx`, `operador.tsx`, `flota.tsx`), con `{ roles, base, titulo, menu, rutas }`. Una entrada del menú con `roles` la ven solo esos roles, y su ruta lleva su propio `RequiereRol` (así el admin tiene pantallas propias dentro de la sección del operador). El router monta cada sección bajo su `base`, protegida por sus roles. Otro rol que entre por la URL ve «Esta pantalla no es para tu rol»; la autorización de verdad la hace la API. Después del login, cada uno va al inicio de su rol, o a la ruta de la que venía (`?volver=`, solo rutas internas).

Para sumar una pantalla:
1. el componente, en `src/roles/<rol>/`;
2. una entrada en `rutas` (relativa a `base`) y, si va en el menú, otra en `menu`, en el archivo del rol;
3. las llamadas con `pedir()`, pasando `clave` si la ruta exige Idempotency-Key.

Están las cuatro: [chofer](#la-pantalla-del-chofer-chofer), [flota](#el-panel-de-la-flota-flota), [pasajero](#la-pantalla-del-pasajero-pasajero) y [operador](#el-panel-del-operador-operador).

## Diseño y PWA

**El estilo: «Ruta nacional»**, la señalética vial argentina (`src/estilos.css`, decisión en `apps/web/DESIGN.md`):
- verde ruta con filete blanco en la barra y los carteles, texto negro asfalto, ámbar para el paso actual y el tramo del auto, rojo solo para anular y para los errores;
- Barlow y Barlow Condensed, servidas desde el mismo origen con `@fontsource` (la CSP no deja traer fuentes de afuera);
- íconos dibujados a mano en SVG (`src/componentes/Iconos.tsx`), incluido el auto del mapa.

**Celular primero en pasajero y chofer.** El mapa queda arriba, fijo, y la hoja del viaje sube por encima al desplazarse. El menú baja a una barra al pie, al alcance del pulgar, y respeta el borde de los celulares con notch (`viewport-fit=cover` y `env(safe-area-inset-*)`). Desde 960 px, el mapa va a la izquierda y la hoja al costado. Operador y flota son pantallas de escritorio que también se adaptan.

**PWA:**
- `public/manifest.json`, con los íconos de `public/` (192, 512, el recortable de Android y el de iOS). Salen de `public/icono.svg` con `node apps/web/scripts/iconos.mjs`, que usa el Chromium de Playwright;
- `public/sw.js`, el service worker, que se registra solo en el build. `/api/*` (incluido el SSE) y las teselas de OpenStreetMap van siempre a la red y no se guardan nunca. `/assets/*` sale primero del caché, porque llevan hash. Las páginas van primero a la red y, sin red, abre la última copia de la app;
- nginx los sirve desde `location /`, con `no-cache` y la misma CSP: el service worker se actualiza en cada despliegue;
- **limitación:** una PWA no manda la ubicación con la pantalla apagada o la app en segundo plano, sobre todo en iPhone. Para la demo alcanza; para uso real haría falta una app nativa.

**El mapa** (`src/mapa/Mapa.tsx`, compartido por pasajero y chofer):
- **la ruta real por las calles** de `GET /api/viajes/rutas` ([docs/api.md](api.md)), en verde con borde blanco. Mientras no llega, o si el ruteo no responde, se dibuja la línea recta punteada;
- **el tramo del auto** hasta el punto que importa ahora (el origen mientras lo viene a buscar), punteado en ámbar;
- **el mojón**, un poste blanco sobre la ruta con los kilómetros que faltan por las calles;
- **el auto**, visto desde arriba. Gira hacia donde maneja y avanza suave entre una posición y la siguiente (~1 s), salvo con `prefers-reduced-motion`. Sin posición reciente se ve gris.
- `src/mapa/useRuta.ts` pide la ruta. La del origen y el destino elegidos se pide de nuevo con cualquier cambio de un extremo (un origen corrido unos metros puede cambiar la ruta entera). La que sale del auto (`{ auto: true }`) se pide de nuevo solo cuando el auto se movió más de 120 m o cambió el destino: así cuida el límite de `GET /rutas` por usuario y el servidor de ruteo.
- **En la conducción simulada del chofer** ([abajo](#la-pantalla-del-chofer-chofer)), su mapa no usa la ruta «del auto»: dibuja la ruta fija del tramo, la misma que maneja, pedida una sola vez. Como es el mismo arreglo durante todo el tramo, el mapa no se redibuja ni se reencuadra con cada paso; el mojón y los minutos cuentan lo que falta sobre esa ruta. La pantalla del pasajero no cambia: ve el auto por `DriverLocationUpdated`, como el de un GPS.

**El cartel.** Arriba de la hoja, el cartel verde dice hacia dónde y en cuántos minutos: «HACIA Terminal de Ómnibus · 8 MIN», «TU CHOFER TE BUSCA EN Plaza 25 de Mayo · 1 MIN». Los minutos y las distancias de los casilleros son por las calles, los mismos del mojón; sin ruta, en línea recta.

## La pantalla del chofer (`/chofer`)

Una sola pantalla (`src/roles/chofer/Panel.tsx`): arriba, el mapa con su auto, la ruta del viaje (o de la primera oferta) y el tramo hasta el pasajero; abajo, la hoja con las ofertas o el viaje activo primero (la oferta vence en 15 s), y después la disponibilidad y la ubicación. Sin estar disponible, lo primero es «Ponerme disponible». Cada oferta es un cartel con la cuenta regresiva y una barra que se vacía. Su estado vive en un store de Zustand propio (`store.ts`). Cómo se aplican las lecturas, las respuestas y los eventos está aparte, sin React ni red (`logica.ts`), y se testea solo (`apps/web/tests/`).

**La base manda, el SSE avisa.** Todo lo que se muestra sale de `GET /api/viajes/chofer/estado`: el registro en la flota, el viaje activo y las ofertas pendientes (ver [docs/flotas.md](flotas.md#rutas)). Se relee:
- al abrir la pantalla: así, **al recargar**, el viaje activo y las ofertas pendientes vuelven solos;
- cada vez que el stream conecta o reconecta;
- con cada evento del viaje o de una oferta: `OfferCreated`, `OfferExpired`, `TripAssigned`, `DriverEnRoute`, `TripStarted`, `RideCompleted` o `RideCancelled`.

Las relecturas se juntan: una en vuelo y, como mucho, otra pendiente. No se usa `Last-Event-ID`: lo que pasó con la pestaña cerrada aparece en la relectura. La posición del pasajero (`PassengerLocationUpdated`) se aplica directo, solo si es del viaje activo y más nueva que la anterior.

**Lecturas atrasadas.** Las lecturas y las respuestas de las acciones (aceptar, avanzar y cambiar la disponibilidad) toman una marca de un mismo contador creciente.
- **Una lectura que empezó antes de la última respuesta** se descarta entera, y se pide otra. Así, un GET lento que salió antes de aceptar no puede volver con `viaje: null` y borrar el viaje recién aceptado.
- **Una lectura que empezó después** se aplica tal cual, aunque diga que el viaje terminó o que es otro.
- **El `version`** solo se compara dentro del mismo viaje: una respuesta repetida por idempotencia no pisa un estado más nuevo.

**Ofertas que vencen en pantalla.**
- La cuenta regresiva usa `venceEn` con el reloj del servidor. El desfase se calcula con el `ahora` de la respuesta y la hora local a mitad del pedido, y corrige un reloj corrido.
- Al llegar a 0, la tarjeta queda «Venció», con el botón deshabilitado, y sale a los 2 s. No espera a `OfferExpired`, que el barrido marca hasta 2 s tarde. Si `OfferExpired` llega antes, la saca enseguida.
- Si otro chofer gana o el pasajero cancela, este chofer no recibe ningún evento. La oferta desaparece en la próxima relectura; si la acepta antes, recibe un 409 y la tarjeta sale con el aviso «Otro chofer tomó el viaje o el pasajero lo canceló».

**Aceptar con resultado incierto.** Si «Aceptar» falla sin una respuesta definitiva (red, 5xx o `CLAVE_IDEMPOTENCIA_EN_CURSO`), no se sabe si el servidor la aceptó. La operación queda en el store, con la oferta y su `Idempotency-Key`, aunque la tarjeta venza y desaparezca. Enseguida se relee el estado:
- si ya aparece el viaje de esa solicitud, se muestra y la operación se cierra;
- si no, la pantalla dice «No sabemos si se aceptó la oferta» y ofrece «Reintentar» con la MISMA clave. Si el primer intento había entrado, la API repite su respuesta (200), aunque la oferta ya haya vencido.

Lo mismo con «Voy en camino», «Inició el viaje» y «Finalizar»: una clave por acción, que se conserva mientras el resultado es incierto. Si una relectura muestra que el viaje ya cambió de estado, la acción se aplicó y no hay nada que reintentar.

**Ubicación.** Se envía mientras el chofer está disponible o tiene un viaje activo. A los 30 s sin envíos, location deja de contarlo como candidato. Por eso, ponerse no disponible lo saca de las ofertas aunque dispatch todavía no filtre por disponibilidad. Las posiciones viejas no se envían: ver la sección siguiente. Hay tres modos: **GPS**, **Manual (demo)** y **Simulada (demo)**, que es el que viene elegido. El elegido se recuerda en la pestaña.

**Conducción simulada («Simulada (demo)»).** Para la demo sin salir a la calle: el auto maneja solo por la ruta real, y el chofer y el pasajero lo ven moverse a la vez, por el camino de siempre (`POST /api/ubicacion/ubicaciones` → location → Redis → dispatch → SSE `DriverLocationUpdated`). Hace lo que `scripts/simular-chofer.mjs`, pero en la pantalla:
- **Sin viaje**, el auto queda quieto y manda su posición cada 1 s, así sigue siendo candidato. Arranca en el punto del script (-27.4620, -58.9960, a 1,5 km de la Plaza 25 de Mayo, en la zona «Resistencia»), o donde quedó: la posición simulada se recuerda en la pestaña (`sessionStorage`), así una recarga a mitad de viaje sigue desde ahí.
- **Asignado:** pide «Voy en camino» solo. El auto arranca cuando se confirma `EN_CAMINO`.
- **En camino:** maneja hasta el origen y frena. «Llegó» es solo de pantalla, sin un estado nuevo: el chofer ve en su cartel la bandera de llegada («Llegaste · esperá al pasajero») con «Inició el viaje» como acción principal, y lo toca él. Mientras maneja, ese botón queda secundario.
- **En curso:** arranca solo hacia el destino. Al llegar, primero location recibe el punto final y después pide «Finalizar» solo. El cobro sale como siempre.
- **Una ruta fija por tramo:** se pide una vez a `GET /api/viajes/rutas` (dispatch → OSRM) desde donde está el auto al empezar el tramo, y la misma se maneja y se dibuja. No sigue la ruta «del auto» del mapa, que se vuelve a pedir cada 120 m. La polilínea suma el auto al principio y el punto exacto al final: la ruta por las calles empieza y termina en la calle más cercana. Si el ruteo no responde, dispatch da la recta (`fuente: 'recta'`) y el auto va en línea recta; si falla el pedido, también.
- **Velocidad y llegada:** 40 km/h (`VELOCIDAD_SIMULADA_KMH`), un paso cada 1 s con el tiempo que pasó de verdad (como mucho 5 s, si la pestaña quedó en segundo plano). Llega cuando le faltan 20 m o menos sobre la ruta, o al terminarla, y se para justo en el punto. La cuenta está aparte, sin React (`src/ubicacion/simulacion.ts`, `tests/simulacion.test.ts`); el manejo, en `useConduccionSimulada.ts`.
- **Los avances automáticos** van por `avanzar()` del store, con su Idempotency-Key y su resultado incierto. Cada uno se pide una sola vez por viaje y acción (`automaticos` en el store). Si queda incierto, no se reintenta solo: queda el «Reintentar» de siempre. Los botones siguen ahí, por si hacen falta a mano.
- **Se frena** al cambiar de modo, al cancelarse el viaje o al cambiar de viaje o de estado. Una respuesta de ruta que llega tarde se ignora.
- **GPS y Manual siguen como antes:** sin avances automáticos y con el envío cada 5 s. El pasajero no tiene este modo.

## El panel de la flota (`/flota`)

Para el `admin_flota` (`src/roles/flota/`, con la misma división que el chofer: `Panel.tsx`, `store.ts` y `logica.ts`). La flota es **la del token**: la pantalla nunca la manda y la API responde 404 a cualquier chofer de otra flota. Usa las rutas de [docs/flotas.md](flotas.md#rutas).

- **El cupo:** «Activos 3 de 5», de `GET /flota`. Con la flota llena, un aviso fijo: «La flota llegó a su límite de 5 choferes activos. Para activar a otro, desactivá uno: así se libera un cupo». El mismo texto aparece en la fila si un «Activar» recibe 409 `LIMITE_FLOTA_ALCANZADO`. El botón no se deshabilita por el contador local: puede estar viejo, y el que decide es el servidor.
- **La lista:** `GET /flota/choferes` responde `{ choferes, siguiente }`. Muestra 10 por página, con «Ver más» mientras `siguiente` no sea null. «Actualizar» y volver a la pestaña releen el cupo y las filas ya cargadas, en un solo pedido de hasta 50. No hay eventos de flotas: así se ve una habilitación nueva o la disponibilidad que cambió el chofer.
- **La habilitación es del admin de la plataforma.** Un chofer sin habilitar dice «Pendiente de habilitación por el admin de la plataforma», y su «Activar» queda deshabilitado. El panel no habilita: lo hace el admin en `/operador/choferes` (abajo).
- **El alta:** el código del chofer (su UUID) y el vehículo. identity no permite buscar cuentas por email, así que el chofer ve su código en `/chofer` mientras no está en una flota, con un botón para copiarlo. Los errores tienen su texto: `CUENTA_NO_ES_CHOFER`, `CHOFER_YA_REGISTRADO`, `PATENTE_YA_REGISTRADA` y `IDENTITY_NO_DISPONIBLE`.

**Viajes y facturación** (`GET /flota/reporte`, reglas en [docs/flotas.md](flotas.md#el-reporte-de-la-flota)):
- dos fechas, «desde» y «hasta», las dos incluidas. Al abrir, el mes en curso;
- se mandan como la medianoche local del «desde» y la del día siguiente al «hasta»;
- un rango al revés o de más de 366 días se avisa sin pedir nada.

Qué se muestra:
- «Facturado», en grande: solo los cobros aprobados;
- los viajes completados;
- en una nota, los pendientes de cobro y los rechazados, con su monto;
- sin viajes: «No hay viajes completados en ese período».

**Cada consulta lleva su propia marca** (un contador del reporte, aparte del de las mutaciones):
- solo se aplica la respuesta, o el error, de la última pedida. Si se eligen dos períodos seguidos, la respuesta del primero no pisa al segundo, aunque llegue después;
- con otro período, los números del anterior se dejan de mostrar mientras carga;
- «Actualizar» y volver a la pestaña releen también el reporte del período elegido.

**Operaciones con resultado incierto** (red, 5xx o `CLAVE_IDEMPOTENCIA_EN_CURSO`). Cada operación tiene su clave en `ClavesDeOperacion`:
- `activar:<id>` y `desactivar:<id>`;
- el alta usa el cuerpo entero como objetivo: con la misma clave y otro cuerpo, la API respondería 422.

Mientras el resultado es incierto, la clave se conserva, y la fila o el formulario quedan bloqueados. Enseguida se relee `GET /flota/choferes/:id`:
- **Activar o desactivar:** si el chofer ya quedó como se pidió, la operación se cierra. Si no, «No sabemos si se activó» y «Reintentar» con la MISMA clave. Si el primer intento había entrado, la API repite su respuesta y no ocupa otro cupo.
- **Alta:**
  - un 200 confirma que el chofer está en la flota. Se da por hecha **solo si el vehículo coincide** con lo enviado;
  - si difiere, se muestra el vehículo real y se aclara que el alta pedida no se aplicó;
  - con 404 (o sin red) sigue incierta, con «Reintentar» (la misma clave) y «Descartar».

**Lecturas atrasadas:** la regla de `/chofer`, por fila.
- **El cupo:** uno leído antes de la última mutación se descarta, y se pide otro.
- **Las filas:** una página leída antes de que se activara un chofer no pisa esa fila, pero sí actualiza las demás.
- **Un alta hecha mientras se recargaba la lista** no se pierde.

## La pantalla del pasajero (`/pasajero`)

El mapa y la hoja ([Diseño y PWA](#diseño-y-pwa)). La hoja, de arriba abajo:

| | Sin viaje | Con viaje |
|---|---|---|
| Cartel | «Pedir un viaje» y, elegido el destino, hacia dónde y los minutos | «Tu viaje», el número, y hacia dónde va lo que importa ahora |
| Cuerpo | DESDE y HASTA: lugar de la lista, toque en el mapa o «Usar mi ubicación» | DESDE → HASTA, el chofer en casilleros (distancia, llegada, antigüedad de la posición) y **las señales** |
| Cierre (tras la línea de carril) | La tarifa estimada y «Pedir viaje» | La tarifa, el cobro y las acciones |

Va en `src/roles/pasajero/`, con la división de las otras pantallas: `Panel.tsx`, `store.ts`, y `logica.ts` sin React ni red (`tests/pasajero-logica.test.ts`). El historial está en `/pasajero/historial`, de a 10 con «Ver más».

**Las señales** (la línea de tiempo, `.linea-tiempo`). Los seis pasos (Pedido, Chofer asignado, En camino, En viaje, Terminado, Cobrado) tienen cada uno su lugar fijo en una grilla de 3 × 2: quedan alineados y ninguno se pisa con otro ni cambia de lugar. Cada evento del SSE enciende su señal con la hora en que llegó, y la asignación muestra cuánto tardó («en 7 s»).
- Lo hecho, en verde con filete blanco. El paso actual, en ámbar con borde negro (como las de advertencia), con «hace N s». Lo que falta, en blanco punteado.
- Una cancelación o «sin choferes» termina en una señal roja «Anulado», con el motivo y quién canceló.
- Lo que pasó con la pantalla cerrada no tiene hora, salvo el pedido, que toma `creadaEn` del servidor.
- Cada señal se enciende con una animación corta, que se apaga con `prefers-reduced-motion`.

**La base manda, el SSE avisa**, como en `/chofer`. El pasajero no tiene un `GET` de su viaje activo: se relee la primera página de `GET /historial` (los más nuevos primero; hay como mucho un viaje activo por pasajero), al abrir, al reconectar y con cada evento que cambia el viaje. Valen las mismas reglas de lecturas atrasadas (la marca de la última acción) y de `version`.
- Un viaje que terminó **queda en pantalla** con su estado final hasta «Pedir otro viaje», así se ve la tarifa final o el motivo de la cancelación.
- `DriverLocationUpdated` se aplica directo, solo si es del viaje activo con chofer y más nueva que la anterior.

**El mapa** (`src/mapa/Mapa.tsx`, ver [Diseño y PWA](#diseño-y-pwa)):
- **Leaflet** (1.9.4, en el bundle) con las teselas de **OpenStreetMap**. Es lo único que viene de afuera, y solo como imágenes (`img-src`, ver la CSP abajo).
- Muestra el origen (verde), el destino (negro), la ruta real, el auto del chofer y el mojón. Pasados 30 s sin posición, el auto se ve gris.
- Se encuadra cuando cambian el origen, el destino o la ruta, sin animación, no con cada posición del auto.
- El origen y el destino se eligen de varias formas:
  - en una lista de **lugares de la demo** (`lugares.ts`, todos dentro de la zona «Resistencia» de `npm run demo:flotas`), para la demo y para Playwright;
  - con un **clic en el mapa**;
  - con **«Usar mi ubicación»** para el origen.

  Un punto a menos de 60 m de un lugar conocido se muestra con su nombre.

**Pedir, cancelar y cobrar** (operaciones con Idempotency-Key):
- **Pedir:** con la estimación a la vista (`GET /tarifas/estimacion`). Si el resultado es incierto, «No sabemos si se pidió el viaje» y «Reintentar» con la MISMA clave; la relectura lo resuelve si el viaje ya existe. Los rechazos conocidos tienen su texto: `SOLICITUD_ACTIVA_EXISTENTE`, `ORIGEN_FUERA_DE_ZONA` y `VIAJE_FUERA_DE_RANGO`.
- **Cancelar:** solo buscando chofer, asignado o con el chofer en camino, lo mismo que permite dispatch; ya en viaje, solo el operador. Se confirma en la misma columna, sin modal. Si el resultado es incierto, se reintenta con la misma clave, y la relectura lo resuelve si el viaje ya no está activo. Si cancela el chofer o un operador, un aviso dice quién y con qué motivo.
- **El cobro** llega por `PaymentCaptured` o `PaymentDeclined`. Esos eventos no se reponen: si llegaron con el stream cortado, cada relectura de un viaje terminado con el cobro sin resolver lo lee de `GET /solicitudes/:id`, que trae el cobro y no lo procesa. «Ver el cobro ahora» usa `POST /solicitudes/:id/cobrar`: lo procesa en el momento, lo devuelve como está si ya se resolvió y nunca cobra dos veces.
- **La ubicación del pasajero** se comparte con el chofer mientras viene a buscarlo (`ASIGNADO` y `EN_CAMINO`), con el mismo control de GPS o manual que el chofer (sin la simulada).
- **«Tu chofer llegó»**, solo de pantalla: con el viaje `EN_CAMINO` y la posición del chofer vigente a 20 m o menos del origen, el cartel pasa a la bandera de llegada (`choferLlego` en `logica.ts`).

## El panel del operador (`/operador`)

Para `operador` y `admin` (`src/roles/operador/`). Una tabla de `GET /panel/viajes`:
- **El filtro:** sin estado, los viajes activos; si no, los de un estado. La búsqueda va en `q`: el id del viaje, del pasajero o del chofer, o el motivo de una cancelación.
- **Las columnas:** el viaje, el pasajero y el chofer van con los últimos 8 caracteres del id (el completo, al pasar el mouse); además, cuándo se pidió, el estado, el recorrido y el importe (el final o el estimado).
- **Sin SSE** (`/eventos` es solo para pasajero y chofer): los activos se vuelven a pedir cada 10 s, salvo mientras se escribe un motivo. Arriba dice hace cuánto se actualizó, y hay un «Actualizar».
- **Cancelar con motivo** (obligatorio para el operador, de 3 a 200 caracteres), en una fila que se abre debajo del viaje, sin modal.
  - La clave es de `cancelar:<id>:<motivo>`: si el resultado es incierto, «Reintentar» usa la MISMA clave.
  - `SOLICITUD_NO_CANCELABLE` dice que el viaje ya terminó o estaba cancelado.

## La habilitación de choferes (`/operador/choferes`, solo `admin`)

El admin de la plataforma habilita a los choferes que cada flota dio de alta (`src/roles/admin/`). En el menú, «Choferes», que el operador no ve; si entra por la URL, «Esta pantalla no es para tu rol».
- **Con el código del chofer:** la API no lista choferes para el admin. Se pega el código (el UUID que ve el chofer en `/chofer` y que su flota usó para el alta; se le sacan los espacios y va en minúsculas) y se toca «Habilitar» o «Deshabilitar» (`POST /admin/choferes/:id/habilitar` o `/deshabilitar`).
- **El resultado:** «Habilitado: Fiat Cronos (AB123CD). Ya lo puede activar el admin de su flota.» Los choferes que se tocan quedan en «Choferes de esta sesión», con las mismas marcas que en `/flota` (habilitado, activo, disponible) y el botón contrario. Deshabilitar lo deja inactivo y no disponible, y libera su cupo si estaba activo.
- **Errores:** 404 `CHOFER_NO_ENCONTRADO` dice que el chofer no está en ninguna flota: primero lo tiene que dar de alta su admin de flota.
- **Una operación a la vez.** Si el resultado es incierto (sin respuesta, 5xx o la clave en curso), «Reintentar» usa la MISMA clave (`habilitar:<id>`) y «Descartar» la cierra. No se verifica con una lectura (no hay `GET` del chofer para el admin), pero las dos acciones son idempotentes.

## Lo compartido entre las pantallas de viaje

Lo usan las pantallas del pasajero y del chofer:

| Módulo | Qué hace |
|---|---|
| `src/tiempo-real/eventos.ts` y `useEventos()` | El cliente del SSE. Usa `fetch` con el `Authorization` (EventSource no permite encabezados) y un lector de `text/event-stream` (`lector-sse.ts`). Reconecta con el `retry:` del servidor más un poco de azar; con cada falla seguida espera el doble, hasta 30 s. Con 401 renueva el token una vez; con 403 se detiene; con 429 (más de 3 pestañas) o 503, avisa y espera. Se cierra al cerrar la sesión. `alConectar` es el momento de releer el estado |
| `src/api/operacion.ts` | `esIncierto(error)` y `ClavesDeOperacion`: una `Idempotency-Key` por objetivo (`disponible:true`, `aceptar:<id>`). Se conserva mientras el resultado es incierto y se descarta con éxito o con un error definitivo |
| `src/ubicacion/` | `useEnvioUbicacion(ruta, activo, { simulada })` y `ControlUbicacion`: GPS con `watchPosition`, coordenadas cargadas a mano (**Manual (demo)**, también si se rechaza el permiso) y, solo en el chofer, **Simulada (demo)** (`simulacion.ts`). El pasajero lo usa con `/ubicacion/ubicaciones/pasajero` |
| `src/viaje/` | Los tipos de las respuestas (de `@viajes/contracts`, solo tipos), las etiquetas de cada estado, la distancia y `Posicion`: la posición en vivo de la otra parte, con «sin datos recientes» pasados los 30 s |

**Posiciones viejas.** location le pone a cada ping la hora del servidor: reenviar un GPS viejo lo haría parecer actual.
- El reenvío cada 5 s manda solo una posición **reciente**: tomada hace 15 s o menos, según el `timestamp` del GPS. Es la mitad de los 30 s de vigencia de location.
- La simulada se envía cada 1 s, con un solo reloj y sin superponer pedidos: 60 por minuto, dentro de las 120 que admite location por usuario (`LIMITE_UBICACIONES_POR_MINUTO`). Más rápido no entraría.
- Pasado ese tiempo deja de enviar, y la pantalla muestra «GPS sin posición reciente (hace N s): no se envía».
- Las coordenadas manuales y la posición simulada las declara la pantalla: se reenvían mientras estén puestas. Se recuerdan en la pestaña (`sessionStorage`), así una recarga a mitad de viaje sigue enviando, y se borran al cerrar sesión.

## Qué no se publica

`/interno/*` (de servicio a servicio, con token de servicio), `/metrics` (lo lee Alloy) y `/ready` (cuenta el estado de Postgres y Redis) responden **404** desde nginx, con el mismo formato de error que los servicios. Cualquier otro `/api/...` también es 404.

- Sin distinguir mayúsculas, porque Express tampoco las distingue: `/api/identity/INTERNO/...` no pasa.
- nginx compara contra la ruta ya decodificada y normalizada: `%69nterno`, `//interno` y `/./interno` tampoco pasan.
- `/health` y el JWKS (`/api/identity/.well-known/jwks.json`) sí se publican.

## La IP del cliente

nginx **reemplaza** `X-Forwarded-For` por la IP que ve (no le agrega): lo que mande el cliente no llega a los servicios. Cada servicio cree en ese encabezado **solo si viene de la IP de nginx** (`CONFIAR_EN_PROXY`, que el Compose arma con `WEB_IP`). Por eso:

- detrás de nginx, el límite de login por IP de identity cuenta por cliente, no por nginx;
- quien llegue directo al puerto de un servicio no puede inventarse otra IP para evadirlo: el encabezado se ignora.

nginx y los servicios comparten la red `proxy` (`WEB_RED`, por defecto `10.250.77.0/28`, fuera de los 172.x que Docker reparte), donde nginx tiene la IP fija `WEB_IP` (`10.250.77.10`). Si esa red choca con otra de la máquina, se cambian las dos variables en el `.env`.

`CONFIAR_EN_PROXY` acepta solo IP o redes en CIDR, separadas por coma. No acepta `true` ni rangos con nombre (`uniquelocal`), que serían confiar en cualquiera de la red. Sin la variable (`npm run dev`), no se confía en nadie.

Con Docker Desktop, todo lo que entra por un puerto publicado le llega a nginx con la IP del gateway de Docker: en la máquina de desarrollo, todos los clientes comparten esa IP. En un host Linux le llega la IP real del cliente.

## Encabezados de la página

- **CSP** (PLAN, Fase B): `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. Todo del mismo origen, sin scripts ni estilos en línea. Lo único de afuera son las teselas del mapa de OpenStreetMap, y solo como imágenes: Leaflet va dentro del bundle, posiciona con la CSSOM (que la CSP permite) y dibuja los puntos como SVG. Las teselas llevan `referrerpolicy=strict-origin-when-cross-origin` (solo el origen), porque la política de uso de OpenStreetMap pide el `Referer` y la página manda `no-referrer`.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`.
- `Permissions-Policy`: geolocalización solo para la página (el chofer comparte su ubicación desde el navegador); cámara, micrófono y pagos, para nadie.
- `server_tokens off`: nginx no dice su versión.

Las respuestas de la API conservan los encabezados de cada servicio (helmet de `platform`, con su CSP `default-src 'none'`). Como el frontend y la API están en el mismo origen, no hace falta CORS.

## SSE

`/api/viajes/eventos` va sin buffer (`proxy_buffering off`, y dispatch manda además `X-Accel-Buffering: no`), así cada evento sale apenas llega. `proxy_read_timeout` es de 60 s, mayor que el latido de 15 s: nginx no corta la conexión por inactividad. Ver [docs/eventos.md](eventos.md).

## Otros detalles

- Los servicios se resuelven con el DNS de Docker en cada pedido (caché de 10 s): nginx arranca aunque alguno todavía no esté, y sigue a un contenedor que se recreó con otra IP. Si un servicio no está, ese prefijo responde 502.
- `X-Request-Id`: nginx manda el suyo y `platform` lo usa como `requestId`, así el mismo pedido se puede seguir en el log de nginx y en el del servicio.
- Imagen `nginxinc/nginx-unprivileged`: nginx corre sin root, en el puerto 8080.
- Los puertos de los servicios (3001, 3004 y 3005) se publican solo para desarrollo. En el entorno publicado para el ataque cruzado, solo se publica el de `web`.

## Probarlo

Con el Compose levantado:

```
npm run web:probar
```

Revisa la CSP y los encabezados de la página, que no haya scripts ni estilos en línea, que la API llegue a los tres servicios, que lo interno responda 404 (también con mayúsculas, codificado y con barras dobles) y que el SSE pase sin buffer. Para el SSE entra como el pasajero del seed, con `IDENTITY_SEED_CONTRASENA` del `.env`.

Probado el 22/11 contra el Compose: las 27 comprobaciones dan bien. Además, el límite de login de identity registró la IP del cliente que vio nginx, no la de nginx ni un `X-Forwarded-For` inventado; directo al puerto 3001, el inventado se ignoró.

El test automático de la IP está en identity (`tests/seguridad/limite-login.test.ts`, «detrás de nginx»): con `CONFIAR_EN_PROXY`, dos clientes detrás del mismo proxy cuentan por separado; la variable no acepta valores que confíen en cualquiera.

## Pendiente

- **TLS y HSTS** en el entorno publicado.

Hechos: la comprobación en Playwright de que ninguna página tiene violaciones de la CSP ([docs/ci.md](ci.md)), el límite de tasa en solicitudes y ubicaciones, y el 413 de nginx con el formato de error de los servicios ([docs/seguridad.md](seguridad.md)).
