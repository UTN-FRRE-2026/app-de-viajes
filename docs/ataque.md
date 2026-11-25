# Ataque cruzado: guía y bitácora

Todos los grupos se atacan entre sí. Nosotros atacamos a cada grupo con la misma lista de pruebas y anotamos lo que encontramos en una sección por grupo. Lo que nos encuentran a nosotros va en [Hallazgos recibidos](#hallazgos-recibidos).

| Quién | Categorías |
|---|---|
| Agos | Autenticación, acceso a recursos ajenos, rate limit |
| Ivan | Carreras, idempotencia (scripts en [`ataque/`](../ataque/README.md)) |
| Maxi | Validación, montos, operaciones costosas |

## Reglas

- **Solo el entorno publicado del grupo atacado**, en la URL que ellos informaron. Nada de su repositorio, sus máquinas ni sus cuentas de nube.
- **Sin DoS masivo.** Las ráfagas son para provocar carreras: decenas de pedidos, no miles. Los scripts tienen tope (500 en `carrera.mjs`, 200 en `idempotencia.mjs`). Nada de pruebas de carga ni de estrés contra otro grupo.
- **Sin tocar a terceros:** ni otros grupos, ni servicios externos que use el atacado (mapas, pagos, correo), ni usuarios reales.
- **Usuarios propios.** Creamos los nuestros con su registro, o usamos los de prueba que publicaron. No usamos credenciales que encontremos.
- **Si algo se rompe, paramos y avisamos.** Un hallazgo que deja el entorno caído o con datos corruptos se informa enseguida, no al final.
- **Evidencia sin secretos.** Los tokens no van a la bitácora ni al repositorio (`-o` de los scripts ya los oculta).
- **Cada hallazgo se reproduce dos veces** antes de anotarlo. Una carrera que salió una vez en diez se anota con esa frecuencia.

## Antes de empezar con un grupo

1. Anotá en su sección la URL publicada, la fecha y la versión o el commit que informaron.
2. Leé su documentación de API: rutas, roles, formato de errores, nombre del encabezado de idempotencia.
3. Creá un usuario por rol que necesites (dos pasajeros y dos choferes, como mínimo, para probar recursos ajenos y carreras).
4. Guardá los tokens en variables de entorno (`ATAQUE_TOKEN`, `TOKEN_CHOFER_A`...), no en archivos del repositorio.
5. Copiá la [plantilla del grupo](#grupo-n) al final de la bitácora.

## Checklist

Cada fila es una prueba concreta. «Falla si» es lo que convierte la prueba en un hallazgo.

### Autenticación (Agos)

| Prueba | Cómo | Falla si |
|---|---|---|
| Sin token | Cada ruta protegida sin `Authorization` | Responde 2xx |
| Token alterado | Cambiá un carácter del payload o de la firma | Responde 2xx |
| `alg: none` | Header `{"alg":"none"}` y firma vacía | Responde 2xx |
| Rol editado | Cambiá el rol del payload sin volver a firmar | Responde 2xx |
| Token vencido | Esperá el `exp` (o usá uno viejo) | Responde 2xx |
| Token en la URL | `?token=` o `?access_token=` en lugar del encabezado | Lo acepta (queda en los logs) |
| Refresh reusado | Usá dos veces el mismo refresh token | El segundo uso emite tokens, o el token rotado sigue sirviendo |
| Logout | Refresh después del logout | Emite tokens |
| Registro con rol privilegiado | `rol: "admin"`, `"operador"` o el de admin de flota en el registro público | Crea la cuenta con ese rol |
| Enumeración | Login con email inexistente contra contraseña mala | Mensajes, códigos o tiempos distintos |

### Acceso a recursos ajenos (Agos)

| Prueba | Cómo | Falla si |
|---|---|---|
| Ver un viaje ajeno | `GET` del viaje de otro pasajero con tu token | 2xx con datos (lo correcto es 404 o 403) |
| Actuar sobre un viaje ajeno | Cancelar, cobrar, finalizar el viaje de otro | 2xx |
| Aceptar la oferta de otro chofer | El id de una oferta que no es tuya | 2xx |
| Identidad en el cuerpo | Mandá `pasajeroId`, `choferId`, `usuarioId` o `fleetId` en el cuerpo o en la query | Usa ese valor en lugar del token |
| Otra flota | Como admin de flota, activar o ver un chofer de otra flota | 2xx |
| Rol equivocado | Rutas de admin u operador con token de pasajero | 2xx |
| Ids adivinables | Ids secuenciales o cortos | Se pueden recorrer |
| Eventos ajenos | Conectate al stream de eventos y hacé que otro usuario viaje | Recibís sus eventos o su posición |

### Rate limit (Agos)

| Prueba | Cómo | Falla si |
|---|---|---|
| Login con contraseña mala | 10 intentos seguidos al mismo email | Nunca responde 429 |
| Login en paralelo | `carrera.mjs` con 50 intentos a la vez | Pasan más intentos que el límite (la cuenta no es atómica) |
| Cambiar la IP | `X-Forwarded-For` distinto en cada intento | El límite se reinicia |
| Variantes del email | Mayúsculas, espacios, `+etiqueta` | Cuentan por separado |
| Respuesta | El 429 | No trae `Retry-After` ni dice cuándo reintentar |

### Carreras (Ivan)

Con `carrera.mjs`. Después de cada ráfaga, **leé el estado del recurso** (el viaje, el chofer, la flota): el código de respuesta no alcanza.

| Prueba | Cómo | Falla si |
|---|---|---|
| Varios choferes aceptan el mismo viaje | Una oferta por chofer; un pedido de aceptar por cada uno, a la vez | Más de un 2xx, o el viaje queda con un chofer distinto del que recibió 2xx |
| Un chofer acepta dos viajes | Dos ofertas al mismo chofer; las dos aceptaciones a la vez | Las dos dan 2xx: el chofer queda con dos viajes |
| Aceptar contra cancelar | Lista mezclada (`ejemplos/aceptar-contra-cancelar.json`) | Viaje cancelado con el chofer bloqueado (no puede tomar otro), o asignado y cancelado a la vez |
| Aceptar justo al vencer | Disparo una ráfaga de aceptaciones a los TTL − 0,2 s, y otra a TTL + 0,2 s | Se acepta una oferta vencida, o la solicitud queda asignada y además ofrecida a otros |
| Un pasajero pide varios viajes | 10 pedidos de crear viaje a la vez, cada uno con su clave | Más de un viaje activo |
| Varias finalizaciones | 20 finalizaciones a la vez, cada una con su clave | Más de un 2xx, dos cobros o dos eventos de fin |
| Varios cobros | 20 cobros del mismo viaje a la vez | Cobro duplicado, o importes o referencias distintos entre respuestas 2xx |
| **Carrera G:** límite de la flota | Activaciones simultáneas de choferes distintos, más que el cupo libre | Quedan más activos que el límite |
| Activar el mismo chofer dos veces | Dos activaciones a la vez, con claves distintas | Ocupa dos cupos (el contador no coincide con los activos) |
| Aceptar contra desactivar | Aceptación y desactivación del chofer a la vez | Viaje asignado a un chofer inactivo o fuera de su zona |
| Registro del mismo email | 20 registros a la vez, cada uno con su clave | Más de una cuenta |
| Refresh en paralelo | 20 refresh con el mismo token a la vez | Más de un 2xx, o el token rotado sigue vivo después |
| Errores bajo concurrencia | En cualquiera de las anteriores | Un 500: suele ser un `deadlock` o un error de unicidad sin capturar |

### Idempotencia (Ivan)

Con `idempotencia.mjs` sobre cada ruta que crea, cobra o cambia algo.

| Prueba | Cómo | Falla si |
|---|---|---|
| Reintento en serie | La misma clave dos veces (fase `serie`) | Dos efectos. Si el reintento recibe un error en lugar de la respuesta original, es una observación (baja) |
| Reintento en paralelo | La misma clave N veces a la vez (fase `paralelo`) | Más de un efecto, o 5xx |
| Otro cuerpo | La misma clave con otro cuerpo (fase `otro-cuerpo`) | Procesa un efecto nuevo. Si devuelve la respuesta vieja sin avisar, es una observación (lo esperado es 422) |
| Sin clave | Fase `sin-clave` | Procesa: la clave no es obligatoria. Severidad según la ruta (en un cobro, alta) |
| Clave de otro usuario | La misma clave fija (`-H "Idempotency-Key: …"` e `--idem ninguna`) con el usuario A y después con el B | B recibe la respuesta guardada de A: fuga de datos (crítica) |
| Clave inválida | Vacía, de un carácter, de 10 000 caracteres | 5xx, o la acepta sin validar |
| Después de un error | Un pedido que falla (400 o 409) y la misma clave con el pedido corregido | Repite el error guardado para siempre |

### Validación (Maxi)

| Prueba | Cómo | Falla si |
|---|---|---|
| Campos de más | `estado`, `precio`, `choferId`, `rol` en cuerpos que no los esperan | Los aplica |
| Tipos | Números como texto, `null`, listas donde va un objeto | 5xx, o los acepta convertidos sin querer |
| JSON roto | Cuerpo cortado, `Content-Type` distinto | 5xx |
| Coordenadas | `lat: 91`, `lng: -181`, `NaN`, texto | Las acepta, o 5xx |
| Ids en la ruta | No UUID, vacío, `../`, muy largo | 5xx |
| Inyección | `' OR '1'='1`, `%`, `_` en búsquedas y filtros | Cambia el resultado o da 5xx |
| `__proto__` | `{"__proto__":{"admin":true}}` en el cuerpo | Cambia permisos o da 5xx |
| Tamaño | Cuerpo de 1 MB | 5xx (lo correcto es 413) |

### Montos (Maxi)

| Prueba | Cómo | Falla si |
|---|---|---|
| Precio del cliente | Mandá un importe o una tarifa en el pedido de viaje | El servidor lo usa |
| Negativos, cero, decimales | En la configuración de tarifa (como admin) | Los acepta, o 5xx |
| Desborde | Importes de 15 o más dígitos, distancias enormes | 5xx, total negativo o redondeado mal |
| Origen igual al destino | Viaje de 0 m | Cobra menos que el mínimo |
| Viaje fuera de rango | Destino a miles de km | Lo acepta con un precio absurdo |
| Cobrar antes de tiempo | Cobrar un viaje no finalizado | Cobra |
| Moneda | Otra moneda en el cuerpo | La acepta |

### Operaciones costosas (Maxi)

| Prueba | Cómo | Falla si |
|---|---|---|
| Paginación | `limite=1000000`, `desde` negativo | Devuelve todo, o 5xx |
| Búsqueda | Texto de 10 000 caracteres, comodines | Tarda segundos, o 5xx |
| Registro | 20 registros seguidos (argon2 o bcrypt en cada uno) | Sin límite y la latencia del resto sube mucho |
| Estimación | 50 estimaciones de tarifa seguidas | Sin límite y llama al proveedor de mapas cada vez |
| Conexiones abiertas | Muchos streams de eventos con el mismo usuario | Sin límite (lo correcto es 429) |
| Polígonos | Una zona de 100 000 puntos (como admin) | 5xx, o el servicio se traba |

## Scripts de carreras e idempotencia

Node 22, sin dependencias, en [`ataque/`](../ataque/README.md). `--ayuda` muestra todas las opciones. Se parametrizan por URL base, ruta, método, cuerpo, tokens, encabezados y nombre del encabezado de idempotencia, porque cada grupo tiene su API.

- **`carrera.mjs`** dispara N pedidos a la vez (iguales, o la lista `pedidos` del JSON) y agrupa estados y cuerpos distintos. Los campos que cambian en cada pedido (`requestId`, `timestamp`) no cuentan al comparar (`--ignorar`). `--max-exitos K` sale con código 2 si hay más de K respuestas 2xx.
- **`idempotencia.mjs`** corre las fases `serie`, `paralelo` y `otro-cuerpo` (y `sin-clave` si se pide) y da un veredicto por fase: OK, OBSERVACIÓN, FALLA o INCONCLUSO. Identifica el efecto por `--campo-id` (por defecto `id`). Si el grupo tiene un listado, `--contar-ruta` y `--contar-campo` cuentan los efectos antes y después de cada fase.
- En la ruta y el cuerpo: `{i}` es el número de pedido, `{uuid}` un UUID nuevo, `{corrida}` un valor fijo en toda la corrida y `{fase}` uno nuevo en cada fase de `idempotencia.mjs` (para recursos con unicidad, como un email).
- `-o evidencia.json` guarda pedidos y respuestas, sin los tokens. Se adjunta al hallazgo.

Para otro grupo: copiá un JSON de `ataque/ejemplos/`, cambiá la URL, las rutas, los cuerpos y, si hace falta, `--clave-encabezado`. Los tokens van por `-t` o `ATAQUE_TOKEN`.

### Ejemplo: contra nuestra API

Con el Compose levantado, la API está en `http://localhost:8080/api` (nginx: `/api/identity/` va a identity y `/api/viajes/` a dispatch). Los usuarios de prueba son `pasajero@viajes.test`, `chofer@viajes.test`, `operador@viajes.test`, `admin@viajes.test` y `admin.flota@viajes.test`, con la contraseña `IDENTITY_SEED_CONTRASENA` del `.env` (solo desarrollo).

```sh
export BASE=http://localhost:8080/api
token() {  # token de un usuario del seed
  node -e 'fetch(process.argv[1]+"/identity/login",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({email:process.argv[2],contrasena:process.argv[3]})}).then(r=>r.json()).then(j=>console.log(j.token))' \
    "$BASE" "$1" "$IDENTITY_SEED_CONTRASENA"
}
PASAJERO=$(token pasajero@viajes.test); ADMIN=$(token admin@viajes.test)
```

| Qué | Comando | Lo que da nuestra API |
|---|---|---|
| Un pasajero pide 10 viajes a la vez | `node ataque/carrera.mjs -u $BASE -r /viajes/solicitudes -b '{"origen":{"lat":-27.4511,"lng":-58.9865},"destino":{"lat":-27.4369,"lng":-58.9808}}' -t $PASAJERO -n 10 --max-exitos 1` | 1×201 y 9×409 `SOLICITUD_ACTIVA_EXISTENTE` (cancelalo después). Hace falta un chofer disponible en la zona: sin choferes, la solicitud termina en `SIN_CHOFERES`, que no cuenta como activa, y la prueba no dice nada |
| 20 cobros del mismo viaje | `node ataque/carrera.mjs -u $BASE -r /viajes/solicitudes/<id>/cobrar -b '{}' -t $PASAJERO -n 20` | 20×200 con un solo cuerpo distinto: la misma `referencia` y el mismo estado |
| Aceptar contra cancelar | Completá `ataque/ejemplos/aceptar-contra-cancelar.json` con la oferta, la solicitud y los dos tokens: `node ataque/carrera.mjs -c ataque/ejemplos/aceptar-contra-cancelar.json` | La cancelación, 200; la aceptación, 200 o 409 `SOLICITUD_NO_DISPONIBLE`. El viaje queda `CANCELADO_PASAJERO` y el chofer libre |
| Registro del mismo email | `node ataque/carrera.mjs -c ataque/ejemplos/registro.json` | 1×201 y 19×409 `IDENTIFICADOR_EN_USO` |
| La misma clave en el registro | `node ataque/idempotencia.mjs -c ataque/ejemplos/registro.json` | serie: el 201 repetido byte a byte, con `Idempotent-Replayed: true`; paralelo: 1×201 y el resto 409 `CLAVE_IDEMPOTENCIA_EN_CURSO` (o el 201 repetido si ya terminó); otro-cuerpo: 422 `CLAVE_IDEMPOTENCIA_REUTILIZADA` |
| La misma clave en la tarifa | `node ataque/idempotencia.mjs -c ataque/ejemplos/tarifa.json -t $ADMIN` | Igual, con `version` como id del efecto: una sola versión nueva por clave. **Cambia la tarifa del entorno local** |
| Refresh en paralelo | `node ataque/carrera.mjs -u $BASE -r /identity/refresh -b '{"refreshToken":"<rt>"}' --idem ninguna -n 20 --max-exitos 1` | 1×200 y 19×401 `REFRESH_INVALIDO`; después, el token nuevo tampoco sirve (la familia queda revocada) |

Las rutas de dispatch con efecto, todas con `Idempotency-Key` obligatoria (`services/dispatch/src/infra/http/rutas.ts` y `rutas-flotas.ts`), con el prefijo `/viajes`:

| Ruta | Rol |
|---|---|
| `POST /solicitudes` | pasajero |
| `POST /ofertas/:id/aceptar` | chofer |
| `POST /solicitudes/:id/en-camino`, `/iniciar`, `/finalizar` | chofer |
| `POST /solicitudes/:id/cancelar` | pasajero, chofer, operador, admin |
| `POST /solicitudes/:id/cobrar` | pasajero, operador, admin |
| `PUT /admin/tarifas`, `PUT /admin/flotas/:id`, `PUT /admin/zonas/:id`, `PUT /admin/flotas/:id/zonas` | admin |
| `POST /admin/choferes/:id/habilitar`, `/deshabilitar` | admin |
| `POST /flota/choferes`, `POST /flota/choferes/:id/activar`, `/desactivar` | admin de flota |
| `PUT /chofer/disponibilidad` | chofer |

Qué debería pasar en cada carrera de nuestra API, y con qué test lo probamos, está en el [ADR 0012](adr/0012-inventario-carreras.md).

## Severidad

| Nivel | Cuándo |
|---|---|
| Crítica | Dinero (cobro doble, monto elegido por el cliente), datos de otro usuario, tomar una cuenta o un rol que no es tuyo |
| Alta | Se rompe una invariante del dominio: dos choferes en un viaje, un chofer con dos viajes, una flota por encima del límite, un efecto doble con la misma clave |
| Media | Estado inconsistente que se recupera solo, enumeración de usuarios, falta de límite en algo costoso, 5xx reproducible |
| Baja | Códigos o mensajes incorrectos, encabezados de seguridad, un reintento que recibe un error en lugar de la respuesta original |

## Plantilla de hallazgo

```markdown
#### G<grupo>-<número>. <Título corto: qué se rompe>

- **Categoría:** carreras | idempotencia | autenticación | recursos ajenos | rate limit | validación | montos | costosas
- **Severidad:** crítica | alta | media | baja
- **Quién lo encontró y cuándo:** <nombre>, <fecha y hora>
- **Ruta:** `<MÉTODO> <ruta>`
- **Frecuencia:** <n de m intentos>

**Pasos para reproducir**
1. …
2. …

**Esperado:** …
**Obtenido:** …

**Evidencia:** comando exacto (sin tokens), salida resumida, `evidencia-<id>.json` de `-o`, captura si hace falta.

**Impacto:** qué puede hacer un usuario malicioso o qué le pasa a uno común.

**Sugerencia:** el mecanismo que lo impediría (por ejemplo, `FOR UPDATE` de la fila, un `UPDATE` condicional, un índice único, la clave en la transacción del efecto).
```

## Bitácora

Una sección por grupo atacado. Copiá la plantilla de abajo y reemplazá la N.

### Grupo N

- **URL atacada:**
- **Versión o commit informado:**
- **Fechas:**
- **Usuarios que creamos:**
- **Documentación de su API:**

| Categoría | Quién | Hecho | Hallazgos |
|---|---|---|---|
| Autenticación | Agos | ⬜ | |
| Recursos ajenos | Agos | ⬜ | |
| Rate limit | Agos | ⬜ | |
| Carreras | Ivan | ⬜ | |
| Idempotencia | Ivan | ⬜ | |
| Validación | Maxi | ⬜ | |
| Montos | Maxi | ⬜ | |
| Operaciones costosas | Maxi | ⬜ | |

#### Hallazgos

(Uno por hallazgo, con la plantilla. Si una categoría no dio nada, anotá qué se probó.)

## Hallazgos recibidos

Lo que otros grupos encontraron en nuestro sistema. Cada uno se corrige con un test que **falla antes** del arreglo y **pasa después**, en el mismo PR.

| # | Grupo | Hallazgo | Severidad | Causa raíz | Commit o PR | Test | Estado |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

Para cada uno, debajo de la tabla:

```markdown
#### R<número>. <Título>

- **Reportado por:** grupo <N>, <fecha>. Hallazgo original: <enlace o id>
- **Severidad:** según la tabla de arriba (y la del grupo, si no coincide)
- **Causa raíz:** qué del código o de la configuración lo permitía, con el archivo
- **Arreglo:** commit o PR
- **Test:** ruta del test. Falla en el commit anterior al arreglo y pasa después (anotá cómo se comprobó)
- **Qué más revisamos:** otras rutas o casos de uso con el mismo patrón
```
