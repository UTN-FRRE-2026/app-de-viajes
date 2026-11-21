import {
  CancelarBody,
  ConfigurarTarifaBody,
  CrearSolicitudBody,
  EstimacionQuery,
  HistorialQuery,
  PanelQuery,
  ParamsId,
  SinBody,
  type EstimacionRespuesta,
} from '@viajes/contracts';
import {
  autenticar,
  requerirRol,
  usuarioDe,
  validar,
  type crearIdempotencia,
  type Rol,
  type VerificadorToken,
} from '@viajes/platform';
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

/**
 * Todo POST con efecto exige Idempotency-Key (PLAN 3.5). `idempotente` va al final de la cadena:
 * un pedido sin permiso o mal formado no ocupa la clave. El código que recibe (201 o 200) es el que
 * responde la ruta: se guarda para repetirlo en los reintentos.
 */
export function rutasDespacho(
  casos: CasosDeUso,
  verificar: VerificadorToken,
  idempotente: ReturnType<typeof crearIdempotencia>,
): Router {
  const r = Router();
  r.use(autenticar(verificar));

  r.post('/solicitudes', requerirRol('pasajero'), validar({ body: CrearSolicitudBody }), idempotente(201), async (req, res) => {
    const { origen, destino } = req.body as CrearSolicitudBody;
    const solicitud = await casos.crearSolicitud({ pasajeroId: usuarioDe(req).id, origen, destino });
    res.status(201).json(solicitud);
  });

  // Estimación de tarifa. Sin efectos: GET y sin Idempotency-Key. El chofer no la necesita.
  r.get('/tarifas/estimacion', requerirRol('pasajero', 'operador', 'admin'), validar({ query: EstimacionQuery }), async (req, res) => {
    const { origenLat, origenLng, destinoLat, destinoLng } = req.query as unknown as EstimacionQuery;
    const estimacion: EstimacionRespuesta = await casos.estimarTarifa({
      origen: { lat: origenLat, lng: origenLng },
      destino: { lat: destinoLat, lng: destinoLng },
    });
    res.set('Cache-Control', 'no-store').json(estimacion);
  });

  // Configuración de la tarifa: solo el admin. El GET devuelve la vigente con su versión.
  r.get('/admin/tarifas', requerirRol('admin'), async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await casos.obtenerTarifa());
  });

  // El PUT reemplaza la tarifa completa y devuelve la versión nueva. Moneda, versión y autor los pone el
  // servidor (el autor sale del token). La versión, la auditoría y la Idempotency-Key van en una transacción.
  r.put('/admin/tarifas', requerirRol('admin'), validar({ body: ConfigurarTarifaBody }), idempotente(), async (req, res) => {
    const tarifa = await casos.configurarTarifa({ valores: req.body as ConfigurarTarifaBody, adminId: usuarioDe(req).id });
    res.set('Cache-Control', 'no-store').json(tarifa);
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
    idempotente(),
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
      idempotente(),
      async (req, res) => {
        res.json(await accion({ solicitudId: req.params['id'] as string, choferId: usuarioDe(req).id }));
      },
    );
  }

  // Cobrar ahora, sin esperar al barrido. Si ya está aprobado o rechazado, lo devuelve como está:
  // nunca cobra dos veces. Proveedor caído: 503 y el cobro sigue PENDIENTE.
  r.post(
    '/solicitudes/:id/cobrar',
    requerirRol('pasajero', 'operador', 'admin'),
    validar({ params: ParamsId, body: SinBody }),
    idempotente(),
    async (req, res) => {
      const usuario = usuarioDe(req);
      res.json(
        await casos.cobrarViaje({
          solicitudId: req.params['id'] as string,
          usuarioId: usuario.id,
          veTodos: usuario.rol === 'operador' || usuario.rol === 'admin',
        }),
      );
    },
  );

  r.post(
    '/ofertas/:id/aceptar',
    requerirRol('chofer'),
    validar({ params: ParamsId, body: SinBody }),
    idempotente(),
    async (req, res) => {
      // El chofer es siempre el del token: nadie puede aceptar en nombre de otro.
      const solicitud = await casos.aceptarOferta({ ofertaId: req.params['id'] as string, choferId: usuarioDe(req).id });
      res.json(solicitud);
    },
  );

  return r;
}
