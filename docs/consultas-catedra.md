# Consultas a la cátedra

Armadas el 13/11/2026 al comparar los dos enunciados (TP Final ProgIV v1.0 y TP Integrador v2.0 preliminar). Completar la columna **Respuesta** con lo que diga la cátedra, quién lo dijo y la fecha. El [plan](../PLAN.md) se ajusta con esas respuestas.

La consulta 1 es la única que **frena trabajo**: hasta tenerla no se mueven `services/dispatch` ni `services/identity`.

| # | Consulta | Por qué importa | Qué asumimos mientras tanto | Respuesta |
|---|---|---|---|---|
| 1 | **¿El Integrador exige microservicios? ¿Cuántos?** En el grupo se recuerda que se habló de tres. | Ninguno de los dos documentos los menciona. Define toda la arquitectura. | Un solo backend modular. No se consolida nada hasta la respuesta. Si son tres: identidad · viajes (con flotas y tarifas) · ubicación. | |
| 2 | **¿Los tres temas de las exposiciones los elige el grupo? ¿Pueden ser los dos que expusimos nosotros más uno que ProgIV ya exige?** | Son 15 puntos. | Elegimos: condiciones de carrera y control de concurrencia · idempotencia y deduplicación · Redis: caché y datos efímeros. | |
| 3 | **¿«Tres temas» son tres filas de la lista de 20?** Varias exposiciones cubrieron dos temas juntos. | Cambia cuánto hay que implementar. | Tres filas de la lista. | |
| 4 | **Fechas del Integrador:** entrega y coloquio. ¿Tiene controles o ataque cruzado propios? ¿La entrega del 02/12 vale también para el Integrador? | El documento nuevo no trae cronograma y cita secciones (8 y 10) que no incluye. | Que se entrega todo junto el 02/12/2026. | |
| 5 | **Fechas del Control 3, el congelamiento, el ataque cruzado y la defensa de ProgIV.** Si el ataque queda después del 02/12, ¿cómo entran las correcciones de los hallazgos? | Lo único confirmado es la entrega final del 02/12/2026. El enunciado pone congelamiento y ataque dos y una semana antes de la entrega, y las correcciones dentro de la entrega. | Metas internas: tarea pesada medida el 18/11 y sistema completo y publicado el 25/11, listo para congelar cuando lo pidan. | |
| 6 | **¿Existe el grupo 9 en nuestra comisión?** | La tabla de la sección 6 tiene 8 grupos, pero 6.7 define una variante para un grupo 9. Cambia a quién atacamos y quién nos ataca. | Atacamos al grupo 8 y nos ataca el 6. | |
| 7 | **Frontend:** ¿alcanza con una interfaz mínima para los 5 puntos? | ProgIV dice que el frontend no suma nota; la rúbrica del Integrador le da 5 puntos. | Interfaz mínima en React, la necesaria para las pruebas de Playwright. | |
| 8 | **Grafana Cloud:** ¿la cátedra necesita acceso a nuestro stack, o alcanza con mostrarlo en el coloquio y dejar los dashboards exportados? | Las credenciales no pueden ir al repositorio, y el sistema tiene que levantar sin ellas. | Se muestra en vivo; dashboards exportados como JSON y capturas en `docs/evidencias/`. | |
| 9 | **SAST:** ¿hay una herramienta esperada (se vieron Codacy y SonarCloud en clase)? | El repositorio es privado. | Semgrep en GitHub Actions. | |
| 10 | **k6 y el simulador de 6.6:** ¿vale como «simulador propio» un escenario de k6 escrito por nosotros? | ProgIV pide un simulador propio de 500 choferes; el Integrador pide k6. | Sí: un solo escenario de k6 cumple las dos cosas. | |

## Cómo cambia el plan según la respuesta 1

- **No se exigen microservicios:** se sigue el plan tal como está (sección 2).
- **Se exigen tres:** identity y dispatch quedan como servicios separados, como hoy; dispatch absorbe flotas y tarifas, y ubicación es el tercero. Vuelve la mensajería entre servicios (el `outbox` ya existe) y hace falta un punto de entrada único para el frontend. Los temas de exposición podrían cambiar a favor de «base de datos por servicio» o «publicación/suscripción».
