# Arquitectura: monorepo de microservicios

> **Actualizado el 13/11/2026.** La cátedra confirmó que exige como mínimo tres microservicios. Son `identity`, `dispatch` y `location`; los límites y la comunicación entre ellos están en la sección 2 del [plan](../PLAN.md). Del plan original ya no corren los nueve servicios, RabbitMQ ni las imágenes versionadas.

## ¿Monorepo no es lo mismo que monolito?

No. Son dos decisiones independientes:

- **Monorepo** describe **dónde está el código**: un solo repositorio de git con varios proyectos.
- **Monolito** describe **cómo corre el sistema**: un solo proceso o desplegable que hace todo, normalmente con una base de datos compartida.

| | Un repositorio | Varios repositorios |
|---|---|---|
| **Un solo desplegable** | Monolito clásico | Monolito partido en librerías (raro) |
| **Muchos desplegables** | **Monorepo de microservicios** ← nuestro caso | "Polyrepo" de microservicios |

## Qué hace que esto sea microservicios

Lo que define a un microservicio no es tener su propio repositorio, sino estas cuatro cosas:

1. **Proceso separado:** cada servicio tiene su contenedor, su puerto y su `/health`. Si dispatch se cae, identity sigue respondiendo.
2. **Datos propios:** cada servicio tiene su base y su usuario de Postgres. `infra/postgres/init` hace `REVOKE ALL ... FROM PUBLIC`, así que dispatch no puede leer la base de identity aunque quiera.
3. **Comunicación solo por contratos:** HTTP interno con timeout o Redis Pub/Sub, con los tipos en `packages/contracts`. Ningún servicio importa código de dominio de otro.
4. **Despliegue independiente:** cada servicio tiene su propia imagen y su contenedor, y se puede reiniciar sin tocar a los demás.

Si se rompe cualquiera de las cuatro, aunque los servicios estén en repositorios distintos, el resultado es un **monolito distribuido**: por ejemplo, si location hace `SELECT` en la base de dispatch, o si para deployar uno hay que deployar todos.

## Qué se comparte y dónde está el riesgo

`packages/kernel`, `packages/platform` y `packages/contracts` son **librerías**: se compilan dentro de cada imagen, no son un servicio. Comparten infraestructura (logger, errores, verificación de JWT) y contratos, nunca reglas de negocio.

El riesgo de un monorepo es que acoplar resulta tentador, porque está a un `import` de distancia. Lo controlamos así:

- La regla `no-restricted-imports` de ESLint impide que `src/dominio/**` importe `express`, Prisma, Redis, Rabbit, `@viajes/platform` o cualquier `infra/`. `npm run lint` falla si alguien lo hace.
- Las bases separadas impiden el acoplamiento por datos.

## Por qué monorepo

- Lo piden ambos enunciados («en un mismo repositorio»).
- Somos 3 personas: con un repositorio por servicio tendríamos tres configuraciones de CI, tres juegos de dependencias y tres lugares donde abrir PRs.
- **Cambios atómicos:** si cambia el contrato de la búsqueda de candidatos, location y dispatch se actualizan en el mismo PR y los tests lo verifican juntos.
- Un solo `docker compose up` levanta todo.

**Contra:** en un polyrepo el aislamiento viene "gratis", pero hay que versionar y publicar las librerías compartidas. Acá el aislamiento lo garantizan el lint y las bases separadas.

> **Para la defensa:** «Es un monorepo de microservicios. El repositorio es uno, pero cada servicio es un proceso aparte, con base propia e imagen propia, y se comunica solo por HTTP y eventos».
