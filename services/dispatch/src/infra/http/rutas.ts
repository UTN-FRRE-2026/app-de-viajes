import { CancelarBody, CrearSolicitudBody, HistorialQuery, PanelQuery, ParamsId, SinBody } from '@viajes/contracts';
import { autenticar, requerirRol, usuarioDe, validar, type Rol, type VerificadorToken } from '@viajes/platform';
import { Router } from 'express';
import type { CasosDeUso } from '../../dominio/casos-uso/index.js';
import type { QuienCancela } from '../../dominio/entidades/index.js';

/** El admin cancela como operador: queda CANCELADO_OPERADOR y también tiene que dar motivo. */
const QUIEN_CANCELA: Partial<Record<Rol, QuienCancela>> = {
  pasajero: 'pasajero',
  chofer: 'chofer',
  operador: 'operador',
  admin: 'operador',
};

export function rutasDespacho(casos: CasosDeUso, verificar: VerificadorToken): Router {
  const r = Router();
  r.use(autenticar(verificar));

  r.post('/solicitudes', requerirRol('pasajero'), validar({ body: CrearSolicitudBody }), async (req, res) => {
    const { origen, destino } = req.body as CrearSolicitudBody;
    const solicitud = await casos.crearSolicitud({ pasajeroId: usuarioDe(req).id, origen, destino });
    res.status(201).json(solicitud);
  });

  // Historial propio: el usuario sale del token, así que nadie puede pedir el de otro.
  r.get('/historial', requerirRol('pasajero', 'chofer'), validar({ query: HistorialQuery }), async (req, res) => {
    const usuario = usuarioDe(req);
    const { limite, desde } = req.query as unknown as HistorialQuery;
    res.json(
      await casos.historial({ usuarioId: usuario.id, como: usuario.rol === 'chofer' ? 'chofer' : 'pasajero', limite, desde }),
    );
  });

  r.get('/panel/viajes', requerirRol('operador', 'admin'), validar({ query: PanelQuery }), async (req, res) => {
    const { estado, q, limite, desde } = req.query as unknown as PanelQuery;
    res.json(await casos.panelOperador({ limite, desde, ...(estado ? { estado } : {}), ...(q ? { texto: q } : {}) }));
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
    requerirRol('pasajero', 'chofer', 'operador', 'admin'),
    validar({ params: ParamsId, body: CancelarBody }),
    async (req, res) => {
      const usuario = usuarioDe(req);
      const solicitud = await casos.cancelarSolicitud({
        solicitudId: req.params['id'] as string,
        usuarioId: usuario.id,
        quien: QUIEN_CANCELA[usuario.rol] as QuienCancela,
        motivo: (req.body as CancelarBody).motivo ?? null,
      });
      res.json(solicitud);
    },
  );

  // Acciones del chofer asignado. El chofer es siempre el del token.
  const acciones = {
    'en-camino': casos.marcarEnCamino,
    iniciar: casos.iniciarViaje,
    finalizar: casos.finalizarViaje,
  } as const;
  for (const [ruta, accion] of Object.entries(acciones)) {
    r.post(
      `/solicitudes/:id/${ruta}`,
      requerirRol('chofer'),
      validar({ params: ParamsId, body: SinBody }),
      async (req, res) => {
        res.json(await accion({ solicitudId: req.params['id'] as string, choferId: usuarioDe(req).id }));
      },
    );
  }

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
