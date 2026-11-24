import { CandidatosQuery, UbicacionBody, type CandidatosRespuesta } from '@viajes/contracts';
import {
  autenticar,
  ErrorHttp,
  exigirTokenServicio,
  requerirRol,
  usuarioDe,
  validar,
  type VerificadorToken,
} from '@viajes/platform';
import { Router, type RequestHandler } from 'express';
import type { CasosDeUso } from '../../dominio/casos-uso/index.js';

/** `/metrics` lo monta `platform` (crearApp), con su propio token. */
export function rutasUbicacion(
  casos: CasosDeUso,
  verificar: VerificadorToken,
  tokenServicio: string,
  /** Límite de tasa de los pings, por usuario (`limitarTasa`). Sin él, no hay límite. */
  limitarPings: RequestHandler = (_req, _res, next) => next(),
): Router {
  const r = Router();

  // El chofer informa su posición. El id sale del token: un body con choferId se rechaza (strictObject).
  r.post('/ubicaciones', autenticar(verificar), requerirRol('chofer'), limitarPings, validar({ body: UbicacionBody }), async (req, res) => {
    const { lat, lng } = req.body as UbicacionBody;
    await casos.registrarUbicacion({ choferId: usuarioDe(req).id, lat, lng });
    res.status(204).end();
  });

  // El pasajero informa su posición, para que la vea el chofer asignado a su viaje (la regla la aplica
  // dispatch). El id sale del token. Efímera: no se guarda ni entra en la búsqueda de candidatos.
  // Publicar es su único efecto: si no se pudo (sin Redis, caído o sin confirmación en 200 ms), 503.
  r.post('/ubicaciones/pasajero', autenticar(verificar), requerirRol('pasajero'), limitarPings, validar({ body: UbicacionBody }), async (req, res) => {
    const { lat, lng } = req.body as UbicacionBody;
    const resultado = await casos.informarPosicionPasajero({ pasajeroId: usuarioDe(req).id, lat, lng });
    if (resultado === 'error' || resultado === 'sin_publicador') {
      throw new ErrorHttp(503, 'POSICION_NO_PUBLICADA', 'No se pudo publicar la posición; reintentá con la próxima');
    }
    res.status(204).end();
  });

  // Solo para dispatch. No se publica por nginx.
  r.get('/interno/candidatos', exigirTokenServicio(tokenServicio), validar({ query: CandidatosQuery }), async (req, res) => {
    const { lat, lng, limite, radioMetros } = req.query as unknown as CandidatosQuery;
    const candidatos = await casos.buscarCandidatos({ origen: { lat, lng }, radioMetros, limite });
    const cuerpo: CandidatosRespuesta = {
      candidatos: candidatos.map((c) => ({ ...c, actualizadaEn: c.actualizadaEn.toISOString() })),
    };
    res.set('Cache-Control', 'no-store').json(cuerpo);
  });

  return r;
}
