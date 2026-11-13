import { LoginBody, RefreshBody, RegistroBody } from '@viajes/contracts';
import { validar, type Logger } from '@viajes/platform';
import { Router, type Response } from 'express';
import type { CasosDeUso, Sesion } from '../../dominio/casos-uso/index.js';
import type { LimitadorLogin } from '../../dominio/puertos/index.js';
import { limitarLogin } from './limite-login.js';

/** Login y refresh responden lo mismo. `no-store`: ningún proxy ni navegador guarda los tokens. */
function responderSesion(res: Response, sesion: Sesion) {
  res.set('Cache-Control', 'no-store').json({
    token: sesion.token,
    tipo: 'Bearer',
    expiraEnSegundos: sesion.expiraEnSegundos,
    refreshToken: sesion.refreshToken,
    refreshExpiraEnSegundos: sesion.refreshExpiraEnSegundos,
    usuario: sesion.usuario,
  });
}

export function rutasIdentidad(casos: CasosDeUso, limitador: LimitadorLogin, logger: Logger): Router {
  const r = Router();

  r.get('/.well-known/jwks.json', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json({ keys: casos.clavesPublicas() });
  });

  r.post('/registro', validar({ body: RegistroBody }), async (req, res) => {
    res.status(201).json(await casos.registrarUsuario(req.body as RegistroBody));
  });

  r.post('/login', validar({ body: LoginBody }), limitarLogin(limitador, logger), async (req, res) => {
    const body = req.body as LoginBody;
    const sesion = await casos.iniciarSesion(body);
    // Si esto falla el usuario igual entró: solo queda el contador hasta que venza la ventana.
    await limitador.reiniciar(body.email).catch((err: unknown) => {
      logger.warn({ err }, 'login: no se pudo reiniciar el contador de intentos');
    });
    responderSesion(res, sesion);
  });

  // Sin límite de intentos: el refresh tiene 256 bits aleatorios, no hay nada que adivinar.
  r.post('/refresh', validar({ body: RefreshBody }), async (req, res) => {
    responderSesion(res, await casos.renovarSesion((req.body as RefreshBody).refreshToken));
  });

  return r;
}
