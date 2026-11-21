import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { URL_REDIS_TEST } from './redis.js';

/**
 * Proxy TCP delante del Redis de tests, para hacer fallar SOLO la conexión que pasa por él (la del
 * publicador) mientras el resto de location sigue usando Redis directo.
 * - `congelarPedidos`: lo que manda el cliente no llega a Redis (se descarta).
 * - `congelarRespuestas`: Redis ejecuta, pero la respuesta no vuelve al cliente.
 * - `retenerPedidos`: lo que manda el cliente queda guardado en el proxy; `soltar()` lo entrega a
 *   Redis en orden, por la misma conexión (para reanudar un handshake sin cortar).
 * - `rechazar`: acepta la conexión y la corta enseguida (Redis «caído» para ese cliente).
 * - `cortar`: corta las conexiones abiertas; el cliente reconecta solo.
 */
export async function crearProxyRedis() {
  const destino = new URL(URL_REDIS_TEST);
  const sockets = new Set<net.Socket>();
  const estado = { congelarPedidos: false, congelarRespuestas: false, retenerPedidos: false, rechazar: false };
  const retenidos: Array<{ redis: net.Socket; datos: Buffer[] }> = [];

  const servidor = net.createServer((cliente) => {
    if (estado.rechazar) {
      cliente.destroy();
      return;
    }
    const redis = net.connect({ host: destino.hostname, port: Number(destino.port || 6379) });
    sockets.add(cliente);
    sockets.add(redis);
    const cerrar = () => {
      cliente.destroy();
      redis.destroy();
      sockets.delete(cliente);
      sockets.delete(redis);
    };
    const propios = { redis, datos: [] as Buffer[] };
    retenidos.push(propios);
    cliente.on('data', (d) => {
      if (estado.congelarPedidos) return;
      if (estado.retenerPedidos) propios.datos.push(d);
      else redis.write(d);
    });
    redis.on('data', (d) => {
      if (!estado.congelarRespuestas) cliente.write(d);
    });
    for (const s of [cliente, redis]) {
      s.on('close', cerrar);
      s.on('error', cerrar);
    }
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', () => r()));
  const { port } = servidor.address() as AddressInfo;

  const cortar = () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
  };

  return {
    /** Misma base que el Redis de tests: las marcas de publicación quedan donde los tests las leen. */
    url: `redis://127.0.0.1:${port}${destino.pathname}`,
    estado,
    cortar,
    soltar() {
      estado.retenerPedidos = false;
      for (const r of retenidos) for (const d of r.datos.splice(0)) r.redis.write(d);
    },
    async cerrar() {
      cortar();
      await new Promise<void>((r) => servidor.close(() => r()));
    },
  };
}
