# ADR 0008 — Búsqueda de candidatos: Redis GEO con vencimiento en location, y el filtro por flota y zona en dispatch con lotes crecientes

- **Estado:** aceptado
- **Fecha:** 2026-11-24. Registra lo que ya está en `main`: la versión ingenua (#7), la optimizada ([ADR 0005](0005-tarea-pesada.md), 2026-11-19) y el filtro por flota y zona con lotes crecientes (#36).
- **Quiénes participaron:** Maxi (location; dueño del ADR en el reparto) y Agos (el filtro por flota y zona en dispatch). Redacción: Ivan. Revisión: pendiente (Agos y Maxi).
- **Servicios:** location (la búsqueda) y dispatch (el filtro) — 6.4, 6.6 y variante G

## Contexto

Al crear una solicitud, y en cada barrido de ofertas vencidas, dispatch necesita los choferes **más cercanos al origen** que además puedan tomar el viaje. Las dos mitades viven en servicios distintos:

- **la posición** es de location: 500 choferes informan cada 2 s (250 pings por segundo);
- **la aptitud** es de dispatch: habilitado, activo, disponible, sin viaje activo y de una flota que opera en la zona del origen.

Condiciones:

- un chofer que deja de reportar no puede seguir apareciendo (chofer fantasma);
- la búsqueda no puede degradarse bajo la carga de los pings;
- ningún servicio lee la base de otro ([ADR 0002](0002-postgres-prisma.md), [0006](0006-tres-microservicios.md));
- 6.4 pide al menos dos opciones con su costo.

El [ADR 0005](0005-tarea-pesada.md) sacó los pings del pedido HTTP. Este ADR decide cómo se busca y dónde se filtra.

## Opciones consideradas

**Cómo buscar los cercanos:**

| Opción | Por qué no / por qué sí |
|---|---|
| **Haversine en JavaScript sobre Postgres** (la ingenua) | `DISTINCT ON (driver_id)` trae la última posición de **todos** los vigentes, y la distancia y el orden se calculan en JS. No hay índice geográfico. Bajo carga no la hunde el cálculo: cada ping es un commit, y las búsquedas esperan conexiones del pool ocupadas por esos `INSERT` (en 502 de 508 muestras, un `INSERT` esperaba el WAL). p95 de 4668 ms |
| **PostGIS para las posiciones en vivo** (columna geográfica con GIST y un `UPSERT` por ping) | Resuelve el índice, pero sigue pagando un commit por ping: el mismo cuello que midió la ingenua. location no tiene PostGIS (solo está en las bases de dispatch), y el vencimiento seguiría siendo un filtro por fecha más una purga. PostGIS sí es la herramienta para las zonas, que cambian poco |
| **Geohash a mano** (un prefijo indexado) | Hay que buscar la celda y sus vecinas, y filtrar después. Redis GEO ya hace eso por dentro (un geohash de 52 bits por punto). En Postgres seguiría el commit por ping |
| **Redis GEO con vencimiento** | La elegida: el ping es una operación en memoria y la búsqueda usa un índice geográfico |

**Dónde filtrar por flota y zona:**

| Opción | Por qué no / por qué sí |
|---|---|
| **En location** (mandarle la zona o la flota) | Cambia el contrato y le hace saber a location de flotas y zonas, que hoy no conoce |
| **Un solo lote en dispatch** | Si los N más cercanos no sirven, la solicitud queda `SIN_CHOFERES` aunque haya aptos un poco más lejos |
| **Lotes crecientes en dispatch** | La elegida: el contrato no cambia y se encuentra a los aptos que están detrás de los no aptos |

## Decisión

**En location, con `UBICACION_ESTRATEGIA=optimizada`** (`src/infra/redis/repositorio-geo.ts`, detalle en [docs/location.md](../location.md#versión-optimizada-ubicacion_estrategiaoptimizada)):

- **Un ping:** un script Lua actualiza, solo si es más nuevo que lo guardado, `pos` (HASH con las coordenadas originales y la hora), `geo` (o `fuera-geo` si la latitud pasa de ±85,05°) y `visto` (ZSET). También lo encola para el historial.
- **Una búsqueda:**
  1. `GEOSEARCH … BYRADIUS` con `radio × 1,001 + 1 m`, más los de `fuera-geo`;
  2. `HMGET` de `pos` y se descartan las posiciones vencidas, aunque la purga no haya pasado;
  3. la distancia exacta (haversine), el radio, el orden y el desempate los resuelve el dominio (`seleccionarCercanos`): la misma función que usan la ingenua y la de memoria.
- **El margen** cubre dos diferencias: Redis mide sobre otra esfera (sus distancias son un 0,028 % más largas) y cuantiza cada punto (hasta ~0,34 m). Lo que entra de más lo descarta el dominio.
- **Vigencia:** `UBICACION_VIGENCIA_SEGUNDOS`, 30 s por defecto (de 5 a 600). Con un ping cada 2 s, son unos 15 pings sin llegar. La regla (vigente si `registradoEn >= ahora − vigencia`) es la misma en las tres estrategias; la ingenua la pone en el `WHERE`.
- **Purga:** cada 10 s (`LOCATION_PURGA_INTERVALO_MS`), un script Lua borra a los vencidos de las cuatro estructuras.
- **Contrato** `GET /interno/candidatos`: `limite` de 1 a 100 (10 por defecto) y `radioMetros` de 1 a 50 000. Ordenados por distancia; a igual distancia, por `choferId`. Si vienen menos que `limite`, no hay más vigentes en el radio. Sin Redis, 503 `UBICACION_NO_DISPONIBLE`: falla cerrado.

**En dispatch** (`src/dominio/casos-uso/buscar-aptos.ts` y `ElegibilidadPrisma` en `src/infra/db/zonas-prisma.ts`, detalle en [docs/flotas.md](../flotas.md#el-filtro-de-candidatos)):

1. Pide `necesarios + excluidos`, como mínimo 10.
2. Saca los ya ofrecidos y filtra el lote con **una** consulta, conservando el orden de location:
   ```sql
   SELECT d.id FROM drivers d
   JOIN fleet_zones fz ON fz.fleet_id = d.fleet_id AND fz.zone_id = $zona
   WHERE d.id = ANY($ids) AND d.approved AND d.active AND d.available
     AND NOT EXISTS (SELECT 1 FROM driver_active_assignment a WHERE a.driver_id = d.id)
   ```
3. Si no alcanzan y el lote vino **completo** (contado sobre la respuesta original), pide el doble: 10, 20, 40, 80 y 100. Son como mucho 5 pedidos.
4. Si vino incompleto, ofrece a los que quedaron. Si los 100 más cercanos no sirven, `SIN_CHOFERES` con el motivo `tope_agotado` en `dispatch_busquedas_sin_aptos_total`.

Las llamadas van fuera de la transacción, con 1 s de timeout (`LOCATION_TIMEOUT_MS`) y 5 km de radio (`DISPATCH_RADIO_BUSQUEDA_METROS`). Si location falla, la solicitud responde 503 y no se crea; el barrido la deja `BUSCANDO` y reintenta. El filtro lee sin lock: la aceptación vuelve a validar con `FOR SHARE` ([ADR 0012](0012-inventario-carreras.md), filas 7 a 9).

**Los números** ([docs/mediciones.md](../mediciones.md)). Mediana de 3 corridas, con 250 pings/s y 20 búsquedas/s, location con 1 CPU:

| | Ingenua | Optimizada |
|---|---|---|
| `/interno/candidatos` p50 / p95 / p99 | 3527 / 4668 / 5413 ms | 3,4 / 5,9 / 14,6 ms |
| `POST /ubicaciones` p95 | 4624 ms | 3,7 ms |
| Pings aceptados por segundo (pedidos: 250) | 140 | 250 |
| CPU de Postgres | 19 % | 4 % |

Con viajes reales encima de esa carga (24/11, 20 pasajeros en paralelo): con la ingenua, el 100 % de los `POST /solicitudes` responde 503 al segundo y no se crea ningún viaje. Con la optimizada, la asignación tarda 581 ms de p95, y hay 0 ofertas a choferes no aptos en las 9 corridas.

## Consecuencias

- La búsqueda tarda pocos milisegundos bajo la carga de 6.6, y no aparecen choferes fantasma: una posición vencida no se devuelve aunque la purga no haya pasado.
- location no sabe nada de flotas ni de viajes, y dispatch no lee posiciones: cada servicio filtra con sus datos.
- **Redis es imprescindible para location.** Si se cae, pings y búsquedas responden 503. Si se pierde sin persistencia, las posiciones se reponen con los pings siguientes.
- **`GEOSEARCH` no lleva `COUNT`:** trae a todos los del radio y el dominio corta en `limite`. El costo crece con los choferes que hay dentro del radio, no con el tope.
- **Dos maneras de medir la distancia** (la de Redis y la del dominio). Si cambia la esfera o la precisión, el margen tiene que acompañar.
- **Hasta 5 pedidos a location** por búsqueda en el peor caso, y un tope: si los 100 más cercanos no sirven, no se busca más lejos.
- **El filtro lee sin lock.** Puede ofrecer a un chofer que acaba de tomar otro viaje: aceptar le da 409, y la oferta ocupa un lugar de la tanda hasta que vence ([ADR 0012](0012-inventario-carreras.md)).
- **Un chofer que cerró la app** puede recibir ofertas hasta 30 s después.
- **La estrategia por defecto sigue siendo `ingenua`** en la config de location, el `docker-compose.yml` y el `.env.example`. La optimizada se elige con `UBICACION_ESTRATEGIA=optimizada`, como en el entorno de carga.

## Cómo se verifica

- location, `tests/soporte/casos-compartidos.ts`: las mismas reglas contra memoria, ingenua y optimizada. Orden, radio y límite; solo la última posición; el chofer fantasma desaparece al vencer; un ping viejo que llega tarde no pisa al nuevo.
- location, `tests/integracion/equivalencia.test.ts`: 300 choferes y 200 búsquedas con semilla fija dan resultados idénticos en las tres. Además, el borde del radio (r − 0,5, r − 0,3, r + 0,3 y r + 0,9 m; falla sin el margen), los empates, las latitudes polares y el antimeridiano.
- location, `tests/integracion/optimizada.test.ts`: guarda las coordenadas originales; un vencido no aparece antes de la purga; `fuera-geo`; Redis caído da 503.
- location, `tests/seguridad/http.test.ts`: el contrato de `/interno/candidatos`, el límite, el radio y el token de servicio.
- dispatch, `tests/dominio/zonas-busqueda.test.ts`: los tamaños de los lotes, el segundo lote que encuentra al apto, el lote incompleto que corta, el tope agotado, el error de location en el segundo pedido y `completo` con la respuesta original.
- dispatch, `tests/integracion/zonas.test.ts`, contra PostGIS: cada condición del filtro, y el chofer de otra flota que no recibe la oferta aunque esté más cerca.
- dispatch, `tests/externos/buscador-location.test.ts` y `tests/integracion/location.test.ts`: el adaptador, cada forma de fallar y el 503 sin viaje creado.
- Carga: `carga/ubicaciones.js` y `carga/solicitudes.js`, con la evidencia en `docs/mediciones/2026-11-19/` y `docs/mediciones/2026-11-24/`.

## Qué nos haría cambiar de decisión

- **Muchos choferes dentro del radio.** Si la medición muestra que `GEOSEARCH` sin `COUNT` pesa, se le pasa `COUNT`, cuidando que el margen del borde no deje afuera a nadie.
- **El tope se agota en la práctica** (`tope_agotado` en la métrica). Se le manda a location la zona del origen, a costa de cambiar el contrato, o el barrido sigue buscando hasta un plazo.
- **Hacen falta consultas espaciales sobre las posiciones** (por ejemplo, qué choferes están dentro de una zona). PostGIS en location, para el historial; la posición vigente puede seguir en Redis.
- **Perder las posiciones al reiniciar Redis molesta** (por ejemplo, ofertas que tardan unos segundos más al volver). Se configura la persistencia de Redis (AOF), para no depender de los pings siguientes.
