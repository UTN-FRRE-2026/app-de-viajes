# CI: verificar, e2e y sast

`.github/workflows/ci.yml` corre tres jobs en cada PR y en cada push a `main`. Los tres tienen que estar en verde para mergear (PLAN 5.4).

| Job | Qué hace |
|---|---|
| `verificar` | `npm ci`, typecheck, lint, los tests de los servicios y del frontend (contra Postgres y Redis del CI) y `npm audit --audit-level=high` |
| `e2e` | Levanta el sistema entero en Docker Compose y corre los cinco flujos de Playwright. Sube el reporte como artefacto `playwright` |
| `sast` | Semgrep sobre todo el repo. Falla con cualquier hallazgo. Sube el resultado en SARIF como artefacto `semgrep-sarif` |

Las acciones de GitHub van **fijadas por commit**, con el tag en un comentario al lado: un tag lo puede mover el dueño de la acción, un commit no. Semgrep lo marca si no (`github-actions-mutable-action-tag`).

## e2e: Playwright (`e2e/`)

Los flujos de PLAN 5.3, contra nginx (`http://localhost:8080`), como en la demo:

| Archivo | Flujo |
|---|---|
| `01-login-roles.spec.ts` | Cada rol entra a su inicio (pasajero, chofer, operador, admin, admin de flota); sin sesión, una pantalla protegida lleva al login; el pasajero no ve la del operador. En cada página, **ninguna violación de la CSP** de nginx (B5) |
| `02-viaje-completo.spec.ts` | Dos navegadores, pasajero y chofer (con GPS simulado). El chofer se pone disponible, el pasajero elige origen y destino y pide, el chofer acepta y lo lleva. Del lado del pasajero, cada paso de la línea de tiempo se prende **en vivo**, y se ve la distancia del chofer. Ya en viaje, el pasajero no puede cancelar |
| `03-oferta-vence.spec.ts` | Dos choferes: la oferta le llega primero al más cercano, y solo a él (comprobado en la base, `GET /chofer/estado`). La deja vencer y el viaje pasa al otro, que lo acepta |
| `04-flota-limite.spec.ts` | El admin de la Flota Norte activa choferes hasta su límite, y el siguiente no entra («llegó a su límite»). No ve a los choferes de otra flota: ni en su lista ni por la API (404) |
| `05-errores.spec.ts` | Login con credenciales incorrectas; alta de chofer con datos inválidos (marca cada campo y no manda nada); pedir sin origen ni destino; una sesión cerrada desde otro lado lleva al login al recargar |

**Cómo correrlos en local:**

```bash
npm run setup                                     # si no lo corriste
npx -w @viajes/e2e playwright install chromium    # la primera vez (en Linux, con --with-deps)
npm run e2e:levantar                              # Compose con la configuración del e2e, y la demo de flotas
npm run e2e                                       # los flujos; el reporte: npm run reporte -w @viajes/e2e
```

`npm run e2e:levantar` (`e2e/levantar.mjs`) levanta el Compose con tres cambios, que duran hasta el próximo `docker compose up` sin ellos:
- `OFERTAS_SIMULTANEAS=1` y `OFERTA_TTL_SEGUNDOS=6`: una oferta por vez y que venza rápido, para el flujo 3. Con 3 a la vez, los dos choferes la recibirían juntos. Está comprobado: con 3, el flujo 3 falla;
- `IDENTITY_LOGIN_MAX_POR_IP=1000`: el límite de login por IP cuenta también los login correctos, y los flujos entran unas 40 veces desde la misma IP. El límite por email (5 fallos) queda igual: el flujo 5 usa un email que no existe.

**Decisiones:**
- **En serie, con un solo worker:** los flujos comparten los usuarios del seed, y un pasajero o un chofer tienen como mucho un viaje activo.
- **Lo que no es el objeto de cada flujo se prepara por la API**, por ejemplo el pedido del flujo 3 o el chofer nuevo del 4. Antes de cada flujo se deja al pasajero sin viaje activo y al chofer no disponible. Después se liberan los cupos que se usaron, así las corridas locales no llenan las flotas.
- **Las teselas del mapa se responden con una imagen local:** la política de uso de OpenStreetMap no admite tráfico automatizado, y así los flujos no dependen de la red.
- **El GPS es el de Playwright** (`geolocation` y el permiso del contexto): la pantalla del chofer usa el mismo camino que con un GPS real.
- **Evidencias:** en el CI, el artefacto `playwright` trae el reporte HTML y, de lo que falla, la traza, la captura y el video. En local, en `e2e/reporte/` y `e2e/resultados/`, que no se suben al repo.

## sast: Semgrep

Corre la imagen `semgrep/semgrep:1.182.1` con los conjuntos de reglas `p/javascript`, `p/typescript`, `p/nodejsscan`, `p/owasp-top-ten` y `p/secrets`, sin cuenta ni envío de métricas (`--metrics off`).
- **Se excluyen** `docs/mediciones` (salidas de k6), el cliente generado de Prisma y los builds.
- **También dos reglas de `nodejsscan`** que no marcan problemas, sino que avisan que algo está bien puesto: helmet sin `x-powered-by`, y helmet con CSP.

**Un hallazgo hace fallar el job** (`--error`). Si es real, se corrige. Si es un falso positivo, se marca en el código con un comentario `nosemgrep: <regla> -- <por qué>` en la primera línea del hallazgo, con el motivo a la vista para quien revise el PR.

Lo que encontró la primera pasada (11 hallazgos) y qué se hizo:

| Hallazgo | Qué era | Qué se hizo |
|---|---|---|
| `github-actions-mutable-action-tag` (2) | Acciones referidas por tag (`@v4`) | Fijadas por commit |
| `request-host-used` | nginx reenviaba a los servicios el `Host` del cliente | `proxy_set_header Host $proxy_host`: ningún servicio usa el Host, pero así uno inventado no llega |
| `helmet_header_x_powered_by`, `helmet_header_check_csp` | Avisos de que helmet está bien configurado | Excluidas (`--exclude-rule`) |
| `regex_dos` (2) | `x-request-id` y el Bearer de `/metrics` | Falso positivo: una clase acotada (100 y 256 caracteres), lineal. Marcado |
| `node_timing_attack` | Comparación del token del cerrojo en memoria | Falso positivo: no es una credencial, solo existe en los tests y el modo memoria. Marcado |
| `eval_nodejs` | `setInterval` de la purga de location | Falso positivo: recibe una función, no un texto. Marcado |
| `node_secret` (2) | Los scripts de k6 leen `/secretos/tokens-viajes.json` | Falso positivo: los tokens vienen de un archivo montado, no hay secretos en el código. Marcado |

**El SARIF** queda como artefacto. No se sube a la pestaña de seguridad de GitHub porque en un repositorio privado eso necesita GitHub Advanced Security (PLAN 5.4).

En local, con Docker:

```bash
docker run --rm -v "$PWD:/src" -w /src semgrep/semgrep:1.182.1 semgrep scan \
  --config p/javascript --config p/typescript --config p/nodejsscan --config p/owasp-top-ten --config p/secrets \
  --exclude docs/mediciones --exclude '**/generated/**' --exclude '**/dist/**' \
  --exclude-rule ajinabraham.njsscan.good.good_helmet_checks.helmet_header_x_powered_by \
  --exclude-rule ajinabraham.njsscan.good.good_helmet_checks.helmet_header_check_csp \
  --metrics off --error
```
