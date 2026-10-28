import type { RequestHandler } from 'express';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { ErrorHttp } from './errores.js';

export type Rol = 'pasajero' | 'chofer' | 'operador' | 'admin' | 'admin_flota';

export interface Usuario {
  id: string;
  rol: Rol;
  fleetId?: string;
}

/** Puerto: cualquier cosa que convierta un token en un usuario (o falle). */
export type VerificadorToken = (token: string) => Promise<Usuario>;

interface OpcionesJwt {
  issuer: string;
  audience: string;
}

const roles: readonly Rol[] = ['pasajero', 'chofer', 'operador', 'admin', 'admin_flota'];

function crearVerificador(clave: Parameters<typeof jwtVerify>[1], opciones: OpcionesJwt): VerificadorToken {
  return async (token) => {
    const { payload } = await jwtVerify(token, clave, {
      issuer: opciones.issuer,
      audience: opciones.audience,
      algorithms: ['RS256'],
    });
    const rol = payload['rol'];
    if (typeof payload.sub !== 'string' || typeof rol !== 'string' || !roles.includes(rol as Rol)) {
      throw new Error('claims inválidos');
    }
    const fleetId = payload['fleetId'];
    return { id: payload.sub, rol: rol as Rol, ...(typeof fleetId === 'string' ? { fleetId } : {}) };
  };
}

/** Producción: las claves públicas se bajan del JWKS de identity (y se cachean). */
export function verificadorJwks(jwksUrl: string, opciones: OpcionesJwt): VerificadorToken {
  return crearVerificador(createRemoteJWKSet(new URL(jwksUrl)), opciones);
}

/** Tests: JWKS en memoria, sin red. */
export function verificadorJwksLocal(jwks: JSONWebKeySet, opciones: OpcionesJwt): VerificadorToken {
  return crearVerificador(createLocalJWKSet(jwks), opciones);
}

declare module 'express-serve-static-core' {
  interface Request {
    usuario?: Usuario;
  }
}

export function autenticar(verificar: VerificadorToken): RequestHandler {
  return async (req, _res, next) => {
    const encabezado = req.header('authorization');
    const token = encabezado?.startsWith('Bearer ') ? encabezado.slice(7) : undefined;
    if (!token) throw new ErrorHttp(401, 'NO_AUTENTICADO', 'Falta el token');
    try {
      req.usuario = await verificar(token);
    } catch {
      throw new ErrorHttp(401, 'NO_AUTENTICADO', 'Token inválido o vencido');
    }
    next();
  };
}

export function requerirRol(...permitidos: Rol[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.usuario) throw new ErrorHttp(401, 'NO_AUTENTICADO', 'Falta el token');
    if (!permitidos.includes(req.usuario.rol)) throw new ErrorHttp(403, 'ROL_NO_PERMITIDO', 'Tu rol no puede hacer esto');
    next();
  };
}

/** Para handlers que ya pasaron por `autenticar`. */
export function usuarioDe(req: { usuario?: Usuario }): Usuario {
  if (!req.usuario) throw new ErrorHttp(401, 'NO_AUTENTICADO', 'Falta el token');
  return req.usuario;
}
