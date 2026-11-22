import { createHash } from 'node:crypto';
import { LoginBody, ParamsUsuarioInterno, RefreshBody, RegistroBody, type UsuarioInterno } from '@viajes/contracts';
import { exigirTokenServicio, validar, type crearIdempotencia, type Logger } from '@viajes/platform';
import { Router, type Request, type Response } from 'express';
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

/**
 * Idempotency-Key del registro (ADR 0010). No hay token, así que la clave es de un email: la misma
 * clave con otro email es otro registro. En el hash del email, así Redis no guarda emails en sus claves.
 */
const porEmail = (req: Request) =>
  `registro:${createHash('sha256').update((req.body as RegistroBody).email).digest('hex')}`;

/**
 * La huella se guarda en la base, y un SHA-256 sin sal de un cuerpo con la contraseña permitiría
 * probar contraseñas con una copia de la base, sin pasar por argon2. Por eso cuentan solo estos campos.
 */
const sinContrasena = (cuerpo: unknown) => {
  const { email, nombre, rol } = cuerpo as RegistroBody;
  return { email, nombre, rol };
};

export function rutasIdentidad(
  casos: CasosDeUso,
  limitador: LimitadorLogin,
  logger: Logger,
  tokenServicio: string,
  idempotente: ReturnType<typeof crearIdempotencia>,
): Router {
  const r = Router();

  // Solo para otros servicios (dispatch), con IDENTITY_TOKEN_SERVICIO. No se publica por nginx.
  // Devuelve el id y el rol, nada más: alcanza para verificar una cuenta y no expone datos personales.
  r.get('/interno/usuarios/:id', exigirTokenServicio(tokenServicio), validar({ params: ParamsUsuarioInterno }), async (req, res) => {
    const usuario: UsuarioInterno = await casos.consultarUsuario(req.params['id'] as string);
    res.set('Cache-Control', 'no-store').json(usuario);
  });

  r.get('/.well-known/jwks.json', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json({ keys: casos.clavesPublicas() });
  });

  // Exige Idempotency-Key, como los POST de dispatch: un reintento recibe el mismo 201 en lugar
  // de un 409 por el email, y no vuelve a correr argon2.
  r.post(
    '/registro',
    validar({ body: RegistroBody }),
    idempotente(201, { alcance: porEmail, huella: sinContrasena }),
    async (req, res) => {
      res.status(201).json(await casos.registrarUsuario(req.body as RegistroBody));
    },
  );

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

  // Cierra la sesión del refresh enviado. 204 también si el token no existe: es idempotente y no
  // revela qué tokens existen. No pide el access token, así funciona aunque ya haya vencido.
  r.post('/logout', validar({ body: RefreshBody }), async (req, res) => {
    await casos.cerrarSesion((req.body as RefreshBody).refreshToken);
    res.status(204).end();
  });

  return r;
}
