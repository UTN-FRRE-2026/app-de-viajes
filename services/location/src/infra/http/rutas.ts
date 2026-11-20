import { CandidatosQuery, UbicacionBody, type CandidatosRespuesta } from '@viajes/contracts';
import { autenticar, requerirRol, usuarioDe, validar, type VerificadorToken } from '@viajes/platform';
import { Router, type RequestHandler } from 'express';
import type { CasosDeUso } from '../../dominio/casos-uso/index.js';
import { exigirTokenServicio } from './token-servicio.js';

export function rutasUbicacion(
  casos: CasosDeUso,
  verificar: VerificadorToken,
  tokenServicio: string,
  metricas: RequestHandler,
): Router {
  const r = Router();

  // Métricas del proceso y del historial: con el token de servicio, como las rutas internas.
  r.get('/metrics', exigirTokenServicio(tokenServicio), metricas);

  // El chofer informa su posición. El id sale del token: un body con choferId se rechaza (strictObject).
  r.post('/ubicaciones', autenticar(verificar), requerirRol('chofer'), validar({ body: UbicacionBody }), async (req, res) => {
    const { lat, lng } = req.body as UbicacionBody;
    await casos.registrarUbicacion({ choferId: usuarioDe(req).id, lat, lng });
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
