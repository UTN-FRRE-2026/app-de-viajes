# Scripts de ataque: carreras e idempotencia

Para el ataque cruzado (parte de Ivan). La guía completa, las reglas y la bitácora están en [docs/ataque.md](../docs/ataque.md).

Node 22, sin dependencias: solo `fetch` y módulos de `node:`. No hace falta `npm install`.

| Script | Qué hace |
|---|---|
| `carrera.mjs` | Dispara N pedidos a la vez (iguales, o una lista mezclada) y resume estados y cuerpos distintos. `--max-exitos K` marca falla si hay más de K respuestas 2xx |
| `idempotencia.mjs` | La misma Idempotency-Key en serie, en paralelo y con otro cuerpo (y, si se pide, sin clave). Dice si hubo un solo efecto |
| `comun.mjs` | Opciones, pedidos y resúmenes compartidos |

Todo se parametriza: URL base, ruta, método, cuerpo, tokens, encabezados y nombre del encabezado de idempotencia. Por argumentos o con un JSON (`--config`); los argumentos pisan el JSON. `--ayuda` muestra todas las opciones.

```sh
# 20 cobros del mismo viaje, cada uno con su clave: como mucho 1 cobro de verdad
node ataque/carrera.mjs -u http://localhost:8080/api -r /viajes/solicitudes/<id>/cobrar -b '{}' -t "$TOKEN_PASAJERO" -n 20

# La misma clave en serie, en paralelo y con otro cuerpo, contra el PUT de la tarifa
node ataque/idempotencia.mjs -c ataque/ejemplos/tarifa.json -t "$TOKEN_ADMIN"
```

- `-o archivo.json` guarda pedidos y respuestas como evidencia, sin los tokens.
- Código de salida: 0 sin fallas, 2 con una falla posible, 1 por un error de uso.
- El tope es 500 pedidos por ráfaga en `carrera.mjs` y 200 en `idempotencia.mjs`: alcanza para una carrera y no es un DoS.
- Los JSON de `ataque/ejemplos/` apuntan a nuestra API local. Para otro grupo, se copian y se cambian la URL y las rutas.
