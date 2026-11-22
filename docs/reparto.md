# Reparto del desarrollo — Ivan, Agos y Maxi

Actualizado el 13/11/2026 para el [plan v2](../PLAN.md) (tres microservicios y rúbrica nueva del Integrador). Las fases están en la sección 6 del plan. Las fases van por orden y no dependen de fechas: el cronograma de la cátedra se fue corriendo.

Cada integrante es **dueño** de un problema central y de los módulos que lo rodean. Ser dueño no es trabajar solo: la defensa y el coloquio son **individuales** y cualquiera puede tener que explicar cualquier parte.

| | Problema central | Módulos y transversales | Rúbrica del Integrador | ADR |
|---|---|---|---|---|
| **Ivan** | 6.3 Asignación única | dispatch (viajes), idempotencia, tiempo real (SSE), Compose y nginx, despliegue | CI + SAST; temas «idempotencia», «deduplicación» y «condiciones de carrera» | 0001 ✅, 0004 ✅, 0006 ✅, 0011, 0012 |
| **Agos** | Variante G: flotas y zonas | identity, flotas (dentro de dispatch), seguridad transversal, base del frontend | Playwright; frontend | 0002, 0003, 0007, 0009 |
| **Maxi** | 6.6 Tarea pesada | location, tarifas (dentro de dispatch), métricas | k6; Grafana Cloud; temas de margen «Redis: caché» y «datos efímeros» | 0005 ✅, 0008, 0010 |

## Ivan

**Fase A**
- [x] Esqueleto de `services/location` con la forma de los otros dos: health, config, composición, Prisma, verificación de tokens por JWKS y base de test en el CI. Lo hizo Agos (#7).
- [x] Compose sin RabbitMQ y con `location`; base y usuario `location` en `infra/postgres/init`.
- [x] `npm run setup` (migra las tres bases, genera la clave si falta, siembra), `dev` y `start`. Tiene que andar en Windows y en Linux. Probado con un clon limpio en los dos.
- [x] Con Maxi: contrato de `GET /interno/candidatos` en `contracts`, cliente HTTP interno con timeout y token de servicio en `platform`, y adaptador de `BuscadorCandidatos` en dispatch.
- [x] ADR 0001 (TypeScript + ESM) y 0006 (tres microservicios y sus límites); 0004 con el formato de la sección 7.1.

**Fase B**
- [x] viajes: `EN_CAMINO`, `EN_CURSO`, `CANCELADO_CHOFER`, cancelación del operador con motivo, finalizar liberando al chofer en la misma transacción, y un test por transición.
- [x] Historial por pasajero y por chofer; panel del operador con búsqueda.
- [x] Idempotency-Key en `platform` (Redis `SET NX` + registro en la transacción del efecto), aplicada a los seis `POST` de dispatch.
- [x] SSE: relay del `outbox` a Redis Pub/Sub, suscripción solo a viajes propios, reconexión con `Last-Event-ID` ([docs/eventos.md](eventos.md)).
- [x] SSE: posición del chofer asignado, solo para su pasajero ([docs/eventos.md](eventos.md#posición-del-chofer-en-vivo)). location publica las posiciones (Maxi).
- [ ] Frontend: pantallas de pasajero y de operador.
- [ ] Contenedor `web`: nginx que sirve el frontend y hace de reverse proxy a los tres servicios.
- [ ] Despliegue y tag `congelado`.

**Fase C y ataque cruzado**
- [ ] Jobs `e2e` y `sast` en el CI.
- [ ] Ataque a los otros grupos: carreras e idempotencia.
- [ ] ADR 0011 y 0012; autoevaluación 10.6 y tag `entrega-final`.

## Agos

**Fase A**
- [x] flotas en dispatch: choferes, vehículos, habilitación por el admin, disponible / no disponible ([docs/flotas.md](flotas.md)).
- [x] Flotas con `admin_flota` y **carrera G**: `UPDATE ... WHERE active_count < max_active` + `CHECK`, con el test de 50 activaciones contra límite 10.
- [ ] ADR 0002 (Postgres + Prisma) y 0003 (JWT y autorización por recurso).

**Fase B**
- [ ] Zonas (PostGIS), zonas habilitadas por flota y filtro en dispatch de los candidatos que devuelve location, por flota y zona (con Ivan).
- [ ] Aislamiento por `fleetId` en el caso de uso (404 a otra flota, con test) y reporte por flota. Hecho: el aislamiento. Falta: el reporte.
- [ ] En `platform`, para los tres servicios: helmet, CORS restringido, rate limit genérico con 429 y encabezados, validación de encabezados y log por pedido.
- [ ] Tests del bloque 5 que faltan: `constructor.prototype` y claves anidadas, inyección SQL en la búsqueda, rate limit en solicitud y ubicación, acceso a recursos ajenos en cada módulo.
- [ ] Frontend: proyecto base (Vite, router, stores, cliente HTTP, componente de errores), login y pantallas de admin de flota.
- [x] identity: logout y revocación. Lo hizo Maxi (#5).
- [x] Tarifas, PR 2: configuración por el admin (`GET` y `PUT /admin/tarifas`), tarifa global versionada con auditoría, semilla desde el entorno y caché en Redis. Lo tomó del reparto de Maxi ([docs/tarifas.md](tarifas.md)).
- [ ] Tabla de roles y permisos en el README.

**Fase C y ataque cruzado**
- [ ] Playwright: los cinco flujos de la sección 5.3 del plan.
- [ ] Ataque a los otros grupos: autenticación, recursos ajenos y rate limit.
- [ ] ADR 0007 (SSE frente a WebSocket, con Ivan) y 0009 (límite por flota).

## Maxi

**Fase A (es lo que pide el Control 3)**
- [x] location ingenua: un `INSERT` por ping y haversine en JavaScript sobre todos los choferes.
- [x] location optimizada: Redis `GEOADD` / `GEOSEARCH`, vencimiento contra choferes fantasma, historial por cola con escritura en lotes. Se elige con `UBICACION_ESTRATEGIA`.
- [x] `GET /interno/candidatos`, protegido con el token de servicio.
- [x] `/metrics` en `platform` con el lag del event loop (`monitorEventLoopDelay`) y memoria, para los tres servicios. Suma la duración por ruta y, en dispatch, solicitudes, asignaciones, ofertas vencidas y tiempo hasta la asignación.
- [ ] `carga/choferes.js` (500 choferes cada 2 s) y `carga/solicitudes.js`. Hecho como `carga/ubicaciones.js`; falta `carga/solicitudes.js`.
- [x] Hipótesis con número y primera medición en `docs/mediciones.md`.
- [x] ADR 0005 (tarea pesada).

**Fase B**
- [ ] Publicación de cada posición en el canal de Redis del chofer; política de retención. Hecho: la publicación ([docs/location.md](location.md#posición-en-vivo)). Falta: la retención.
- [x] tarifas en dispatch: una función en centavos enteros para estimación y tarifa final, con los tests de borde. Estimación por `GET /tarifas/estimacion` ([docs/tarifas.md](tarifas.md)).
- [x] Configuración de tarifas por el admin: versionada en Postgres, con Idempotency-Key y caché en Redis con invalidación. **La tomó Agostina** (PR 2 de tarifas).
- [x] Cobro simulado idempotente que falla cerrado, con la tarifa final y por qué difiere de la estimación. **Lo hizo Ivan** (PR 3 de tarifas, [docs/tarifas.md](tarifas.md)).
- [ ] Puertos de mapas y pagos con timeout. Hecho: mapas (simulado, con timeout y falla cerrado). Falta: pagos.
- [ ] Caché en Redis de tarifas y zonas, con invalidación. Hecho el de tarifas, por versión (Agostina, PR 2 de tarifas). Falta el de zonas.
- [ ] Frontend: pantallas del chofer.

**Fase C y ataque cruzado**
- [ ] Grafana Cloud: Alloy en un perfil de Compose, métricas de negocio y tres dashboards exportados.
- [ ] `carga/estres.js` y `carga/carrera.js`; mediciones finales con tres corridas.
- [ ] Ataque a los otros grupos: validación, montos y operaciones costosas.
- [ ] ADR 0008 (búsqueda geográfica) y 0010 (idempotencia, con Ivan).

## Dependencias

| Quién espera | Qué | De quién | Cuándo |
|---|---|---|---|
| Maxi (location) | Esqueleto de `services/location` | Ivan | ✅ Lo hizo Agos (#7) |
| Ivan (viajes) | `GET /interno/candidatos` | Maxi | ✅ Integrado (adaptador `buscador-location`) |
| Ivan (viajes) | Chofer → flota → zonas habilitadas, para filtrar candidatos en dispatch | Agos | Inicio de la Fase B |
| Ivan (SSE) | Posiciones publicadas en Redis | Maxi | ✅ Publicadas (canal y contrato en `contracts`); falta la suscripción en dispatch |
| Maxi (cobro) | Idempotency-Key en `platform` | Ivan | ✅ Usada en el cobro (PR 3 de tarifas, que terminó haciendo Ivan) |
| Agos (Playwright) | Pantallas de pasajero, chofer y operador | Ivan, Maxi | Fin de la Fase B |
| Maxi (Grafana) | Log por pedido en JSON | Agos | Fase B |

Mientras se espera, cada uno trabaja con un adaptador falso: para eso está la arquitectura hexagonal.

## Reglas de colaboración

1. **Una rama por tarea y un PR a `main`.** CI en verde y al menos una revisión **con comentarios reales** (ProgIV 2.3); nadie mergea su propio PR sin revisión.
2. **Los PR de un problema central (6.3, 6.6 y G) los revisan los otros dos.**
3. **Commits de los tres, repartidos en el tiempo.** Hoy Maxi no tiene ninguno: su primer PR tiene que entrar en la Fase A.
4. **Cada uno tiene que poder explicar el código que figura a su nombre** (ProgIV 10.5). Lo que escriba un asistente se lee y se entiende antes de commitear.
5. **Un test de concurrencia tiene que fallar cuando se saca la protección** (ver `tests/soporte/demora.ts`).
6. **location y los módulos nuevos de dispatch siguen el patrón de viajes:** dominio sin infraestructura, `composicion.ts` como único lugar que elige adaptadores, tests de dominio en memoria y de concurrencia contra Postgres real.
7. **Ningún servicio lee la base de otro ni importa su dominio.** Lo compartido va en `packages/contracts` (contratos) y `packages/platform` (infraestructura).
8. **Los ADR se escriben cuando se decide,** con al menos dos opciones reales y con «qué nos haría cambiar de decisión».
