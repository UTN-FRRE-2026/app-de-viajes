import { LoginBody, RegistroBody } from '@viajes/contracts';
import { validar, type Logger } from '@viajes/platform';
import { Router } from 'express';
import type { CasosDeUso } from '../../dominio/casos-uso/index.js';
import type { LimitadorLogin } from '../../dominio/puertos/index.js';
import { limitarLogin } from './limite-login.js';

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
    res.set('Cache-Control', 'no-store').json({
      token: sesion.token,
      tipo: 'Bearer',
      expiraEnSegundos: sesion.expiraEnSegundos,
      usuario: sesion.usuario,
    });
  });

  return r;
}
