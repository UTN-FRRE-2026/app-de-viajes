# ADR 0005 — Los pings se sacan del pedido HTTP: posición vigente en Redis GEO e historial por cola con escritura en lotes

- **Estado:** aceptado
- **Fecha:** 2026-11-19
- **Quiénes participaron:** Maxi (dueño de 6.6). Revisión: Agos e Iván.
- **Servicio:** location — tarea pesada 6.6

## Contexto

6.6 pide recibir la ubicación de **500 choferes cada 2 segundos** (250 pings por segundo, de forma sostenida) y, al mismo tiempo, buscar choferes cercanos para cada solicitud de viaje, sin que el servicio se degrade. Además exige implementar y medir la versión ingenua.

La versión ingenua (PR #7) hace un `INSERT` en Postgres por ping, y la búsqueda trae la última posición de todos los choferes y calcula haversine en JavaScript.

Restricciones:
- location corre en un contenedor con **1 CPU**;
- el contrato con dispatch (`GET /interno/candidatos`) ya está escrito y no tiene que cambiar;
- el historial de posiciones se conserva, porque sirve para el recorrido del viaje (6.4);
- en seguridad hay que fallar cerrado (3.7).

La sección 3.3 propone cuatro salidas para una tarea pesada: partirla en pedazos, procesarla como flujo, moverla a otro hilo o sacarla del pedido HTTP a una cola.

## Opciones consideradas

1. **Partir el trabajo en pedazos** (chunking del haversine con `setImmediate`).
   - A favor: simple y no agrega infraestructura.
   - En contra: ataca solo la parte de CPU de la búsqueda. El costo dominante es por ping, no por búsqueda: cada ping sigue siendo un commit en Postgres.
2. **Procesar como flujo** (streams sobre las filas de la búsqueda).
   - A favor: acota la memoria de una búsqueda grande.
   - En contra: con 500 choferes la memoria no es el problema, y no cambia el costo de escribir 250 filas por segundo, una por transacción.
3. **Worker threads** para el cálculo de distancias.
   - A favor: saca la CPU del event loop.
   - En contra: el haversine sobre 500 puntos tarda microsegundos, así que el costo de pasar los datos al worker supera la ganancia. Tampoco toca la escritura.
4. **Sacar el ping del pedido HTTP: cola e índice geográfico** (elegida).
   - **Posición vigente** en Redis: `GEOADD` más un HASH con las coordenadas originales y un ZSET para el vencimiento, escritos por un script Lua atómico.
   - **Búsqueda** con `GEOSEARCH`. La distancia final y el orden los resuelve el dominio, igual que en la ingenua.
   - **Historial** en un Redis Stream. Un consumidor lo escribe en Postgres en lotes de 500 (`createMany`), con `stream_id` único para no duplicar al reintentar.
   - A favor: el pedido HTTP queda en una sola operación en memoria, y Postgres recibe un commit por lote en vez de uno por ping.
   - En contra: suma Redis como dependencia crítica, y el historial pasa a ser consistente con algo de demora (~1 s).

Variante descartada dentro de la opción 4: **mantener la posición vigente en Postgres con `UPSERT` y PostGIS**, y escribir solo el historial en lotes. Sigue pagando un commit por ping. Se compara con Redis GEO en el ADR 0008.

## Decisión

Usamos la opción 4: **cola e índice geográfico**. Los pings no esperan a Postgres: actualizan la posición en Redis y se encolan, y el historial se escribe en lotes fuera del pedido. La versión ingenua queda en el código como referencia (`UBICACION_ESTRATEGIA=ingenua`), detrás del mismo puerto `RepositorioUbicaciones`.

## Consecuencias

**Ganamos:**
- Pings y búsquedas de pocos milisegundos bajo 250 pings por segundo, en la mediana de 3 corridas, contra segundos en la ingenua. El historial guardó todos los pings aceptados. k6 omitió 12 pings en el calentamiento de una de las tres corridas (ver [docs/mediciones.md](../mediciones.md)).
- Postgres deja de ser el cuello de botella: un commit por lote en vez de uno por ping.
- La misma batería de tests y una prueba de equivalencia garantizan que las tres estrategias (memoria, ingenua y optimizada) devuelvan exactamente lo mismo.

**Perdemos:**
- Redis pasa a ser imprescindible para location. Si se cae, pings y búsquedas responden `503` (falla cerrado).
- El historial llega a Postgres con hasta ~1 s de demora.
- Si Postgres está caído más de lo que entra en la cola (500 000 entradas, unos 33 min), se descarta historial. Las posiciones no se pierden, y el descarte se cuenta y se ve en `/metrics` y en el log.

**Queda más difícil:**
- Hay dos lugares con estado: la posición vigente en Redis y el historial en Postgres. Un ping está «en vuelo» en el stream hasta que se escribe.
- Diagnosticar exige mirar la cola: pendientes, ocupación y descartes.
- La recuperación de entradas abandonadas (`XAUTOCLAIM`) depende de un tiempo de inactividad que hay que ajustar.

## Qué nos haría cambiar de decisión

- **Redis deja de estar disponible** en el despliegue, o no se puede operar con persistencia aceptable. Habría que volver a Postgres, con `UPSERT` de la posición y lotes para el historial.
- **El volumen crece mucho:** decenas de miles de choferes en un mismo radio, donde `GEOSEARCH` sin `COUNT` devuelve demasiados candidatos. Habría que pedir lotes con `COUNT` creciente o particionar por zona.
- **Una medición muestra** que la ingenua con `synchronous_commit=off` o con un disco rápido alcanza los mismos números. Entonces la complejidad de la cola no se justificaría.
