import { CrearSolicitudBody, ParamsId, SinBody } from '@viajes/contracts';
import { autenticar, requerirRol, usuarioDe, validar, type VerificadorToken } from '@viajes/platform';
import { Router } from 'express';
import type { CasosDeUso } from '../../dominio/casos-uso/index.js';

export function rutasDespacho(casos: CasosDeUso, verificar: VerificadorToken): Router {
  const r = Router();
  r.use(autenticar(verificar));

  r.post('/solicitudes', requerirRol('pasajero'), validar({ body: CrearSolicitudBody }), async (req, res) => {
    const { origen, destino } = req.body as CrearSolicitudBody;
    const solicitud = await casos.crearSolicitud({ pasajeroId: usuarioDe(req).id, origen, destino });
    res.status(201).json(solicitud);
  });

  r.get('/solicitudes/:id', validar({ params: ParamsId }), async (req, res) => {
    const usuario = usuarioDe(req);
    const solicitud = await casos.obtenerSolicitud({
      solicitudId: req.params['id'] as string,
      usuarioId: usuario.id,
      veTodas: usuario.rol === 'operador' || usuario.rol === 'admin',
    });
    res.json(solicitud);
  });

  r.post(
    '/solicitudes/:id/cancelar',
    requerirRol('pasajero'),
    validar({ params: ParamsId, body: SinBody }),
    async (req, res) => {
      const solicitud = await casos.cancelarSolicitud({
        solicitudId: req.params['id'] as string,
        pasajeroId: usuarioDe(req).id,
      });
      res.json(solicitud);
    },
  );

  r.post(
    '/ofertas/:id/aceptar',
    requerirRol('chofer'),
    validar({ params: ParamsId, body: SinBody }),
    async (req, res) => {
      // El chofer es siempre el del token: nadie puede aceptar en nombre de otro.
      const solicitud = await casos.aceptarOferta({ ofertaId: req.params['id'] as string, choferId: usuarioDe(req).id });
      res.json(solicitud);
    },
  );

  return r;
}
