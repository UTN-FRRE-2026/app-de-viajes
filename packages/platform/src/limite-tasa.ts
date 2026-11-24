import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { ErrorHttp } from './errores.js';
import type { Logger } from './logger.js';

/** Lo que queda de la ventana después de contar un pedido. */
export interface EstadoTasa {
  /** Pedidos contados en la ventana, incluido este. */
  cuenta: number;
  /** Milisegundos hasta que la ventana se reinicia. */
  reinicioMs: number;
}

/**
 * Cuenta pedidos por clave en una ventana fija. Puerto con dos adaptadores: Redis (compartido entre
 * réplicas, el de producción) y memoria (un solo proceso: tests y location sin Redis).
 */
export interface ContadorTasa {
  contar(clave: string, ventanaMs: number): Promise<EstadoTasa>;
}

/**
 * Ventana fija en Redis: `INCR` y, solo la primera vez, `PEXPIRE ... NX` (Redis 7), en un `MULTI`.
 * Atómico: dos pedidos simultáneos nunca leen la misma cuenta, y la clave siempre vence (si el
 * proceso muere entre los dos comandos, el `MULTI` no se aplica a medias).
 */
export function contadorTasaRedis(redis: Redis, prefijo: string): ContadorTasa {
  return {
    async contar(clave, ventanaMs) {
      const k = `${prefijo}${clave}`;
      const resultados = await redis.multi().incr(k).pexpire(k, ventanaMs, 'NX').pttl(k).exec();
      if (!resultados) throw new Error('limite de tasa: MULTI abortado');
      for (const [err] of resultados) if (err) throw err;
      const cuenta = Number(resultados[0]?.[1]);
      const pttl = Number(resultados[2]?.[1]);
      return { cuenta, reinicioMs: pttl > 0 ? pttl : ventanaMs };
    },
  };
}

/**
 * Ventana fija en memoria. Las ventanas vencidas se borran al pasar el tope de claves, así el mapa no
 * crece sin fin con usuarios que no vuelven.
 */
export function contadorTasaMemoria(ahora: () => number = Date.now, maxClaves = 10_000): ContadorTasa {
  const ventanas = new Map<string, { cuenta: number; vence: number }>();
  return {
    async contar(clave, ventanaMs) {
      const t = ahora();
      if (ventanas.size >= maxClaves) {
        for (const [k, v] of ventanas) if (v.vence <= t) ventanas.delete(k);
      }
      let v = ventanas.get(clave);
      if (!v || v.vence <= t) {
        v = { cuenta: 0, vence: t + ventanaMs };
        ventanas.set(clave, v);
      }
      v.cuenta += 1;
      return { cuenta: v.cuenta, reinicioMs: v.vence - t };
    },
  };
}

interface OpcionesLimite {
  contador: ContadorTasa;
  /** Nombre del límite: separa las cuentas (`solicitudes`, `ubicaciones`) y aparece en el log. */
  nombre: string;
  /** Pedidos permitidos por ventana. 0 desactiva el límite (el entorno de carga). */
  maximo: number;
  ventanaMs: number;
  logger: Logger;
  /**
   * De quién es la cuenta. Por defecto, el usuario del token (va después de `autenticar`): un límite
   * por IP castigaría a todos los que salen por la misma (una red móvil, el nginx sin `trust proxy`).
   */
  clave?: (req: Request) => string;
}

const porUsuario = (req: Request) => req.usuario?.id ?? `ip:${req.ip ?? 'desconocida'}`;

/**
 * Límite de tasa genérico, con 429 y los encabezados `RateLimit-*` (borrador IETF, los mismos que el
 * login de identity) y `Retry-After`.
 *
 * Falla abierto: si el contador no responde (Redis caído), el pedido pasa y queda un warn en el log.
 * A diferencia del login (que falla cerrado porque sin contador no hay defensa contra la fuerza bruta),
 * acá el límite protege la capacidad, no un secreto: con Redis caído dispatch ya contesta 503 en las
 * rutas con Idempotency-Key, y en location cortar los pings sería perder las posiciones.
 */
export function limitarTasa({ contador, nombre, maximo, ventanaMs, logger, clave = porUsuario }: OpcionesLimite): RequestHandler {
  if (maximo <= 0) return (_req, _res, next) => next();
  return async (req, res, next) => {
    let estado: EstadoTasa;
    try {
      estado = await contador.contar(`${nombre}:${clave(req)}`, ventanaMs);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), limite: nombre }, 'límite de tasa: contador no disponible, el pedido pasa');
      next();
      return;
    }
    const reinicioSegundos = Math.max(1, Math.ceil(estado.reinicioMs / 1000));
    res.setHeader('RateLimit-Limit', maximo);
    res.setHeader('RateLimit-Remaining', Math.max(0, maximo - estado.cuenta));
    res.setHeader('RateLimit-Reset', reinicioSegundos);
    if (estado.cuenta > maximo) {
      res.setHeader('Retry-After', reinicioSegundos);
      logger.warn({ limite: nombre, usuarioId: req.usuario?.id, ip: req.ip }, 'límite de tasa excedido');
      throw new ErrorHttp(429, 'DEMASIADOS_PEDIDOS', 'Demasiados pedidos. Probá de nuevo en unos segundos');
    }
    next();
  };
}
