# Arquitectura: monorepo de microservicios

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
3. **Comunicación solo por contratos:** HTTP con OpenAPI o eventos por RabbitMQ (ver [eventos.md](eventos.md)). Ningún servicio importa código de dominio de otro.
4. **Despliegue independiente:** cada servicio tiene su imagen OCI con su propio tag semver.

Si se rompe cualquiera de las cuatro, aunque los servicios estén en repositorios distintos, el resultado es un **monolito distribuido**: por ejemplo, si trips hace `SELECT` en la base de dispatch, o si para deployar uno hay que deployar todos.

## Qué se comparte y dónde está el riesgo

`packages/kernel`, `packages/platform` y `packages/contracts` son **librerías**: se compilan dentro de cada imagen, no son un servicio. Comparten infraestructura (logger, errores, verificación de JWT) y contratos, nunca reglas de negocio.

El riesgo de un monorepo es que acoplar resulta tentador, porque está a un `import` de distancia. Lo controlamos así:

- La regla `no-restricted-imports` de ESLint impide que `src/dominio/**` importe `express`, Prisma, Redis, Rabbit, `@viajes/platform` o cualquier `infra/`. `npm run lint` falla si alguien lo hace.
- Las bases separadas impiden el acoplamiento por datos.

## Por qué monorepo

- Lo piden ambos enunciados («en un mismo repositorio»).
- Somos 3 personas: con 11 repositorios tendríamos 11 configuraciones de CI, 11 versiones de dependencias y 11 lugares donde abrir PRs.
- **Cambios atómicos:** si cambia el contrato de `TripAssigned`, el productor y los consumidores se actualizan en el mismo PR y los tests lo verifican juntos.
- Un solo `docker compose up` levanta todo.

**Contra:** en un polyrepo el aislamiento viene "gratis", pero hay que versionar y publicar las librerías compartidas. Acá el aislamiento lo garantizan el lint y las bases separadas.

> **Para la defensa:** «Es un monorepo de microservicios. El repositorio es uno, pero cada servicio es un proceso aparte, con base propia e imagen versionada propia, y se comunica solo por HTTP y eventos».
