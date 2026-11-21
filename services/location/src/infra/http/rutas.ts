import { CandidatosQuery, UbicacionBody, type CandidatosRespuesta } from '@viajes/contracts';
import { autenticar, exigirTokenServicio, requerirRol, usuarioDe, validar, type VerificadorToken } from '@viajes/platform';
import { Router } from 'express';
import type { CasosDeUso } from '../../dominio/casos-uso/index.js';

/** `/metrics` lo monta `platform` (crearApp), con su propio token. */
export function rutasUbicacion(casos: CasosDeUso, verificar: VerificadorToken, tokenServicio: string): Router {
  const r = Router();

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
