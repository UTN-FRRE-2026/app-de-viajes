import {
  AltaChoferBody,
  DisponibilidadBody,
  GuardarFlotaBody,
  ListadoChoferesQuery,
  ParamsId,
  SinBody,
} from '@viajes/contracts';
import { requerirRol, usuarioDe, validar, type crearIdempotencia } from '@viajes/platform';
import type { Request, RequestHandler, Router } from 'express';
import type { CasosDeFlotas } from '../../dominio/casos-uso/flotas.js';

/**
 * Rutas de flotas (variante G, docs/flotas.md). Se montan en el router de dispatch, después de
 * `autenticar`. Todas las escrituras llevan Idempotency-Key, con el resultado guardado en la misma
 * transacción que el cambio.
 *
 * - `/admin/*`: el admin de la plataforma (crea flotas, habilita choferes).
 * - `/flota/*`: el admin_flota, siempre sobre la flota de su token. El alcance se valida en el caso
 *   de uso (404 a otra flota). Las escrituras validan la flota del token **antes** de la idempotencia
 *   y usan un alcance por usuario y flota: si el token cambia de flota, no se repite una respuesta de
 *   la flota anterior.
 * - `/chofer/*`: el chofer, sobre su propio registro (el del token).
 */
export function montarRutasFlotas(
  r: Router,
  casos: CasosDeFlotas,
  idempotente: ReturnType<typeof crearIdempotencia>,
): void {
  /** La flota del token existe: 403 sin `fleetId`, 404 si dispatch no la conoce. */
  const exigirFlota: RequestHandler = async (req, _res, next) => {
    await casos.flotaPropia(usuarioDe(req));
    next();
  };
  const porUsuarioYFlota = (req: Request) => {
    const { id, fleetId } = usuarioDe(req);
    return `${id}:flota:${fleetId}`;
  };
  const params = (req: Request) => req.params['id'] as string;

  // --- Admin de la plataforma ---

  // Crea la flota con el id que identity ya pone como `fleetId` en el token del admin_flota, o cambia
  // su nombre y su límite. 409 si el límite queda por debajo de los activos.
  r.put(
    '/admin/flotas/:id',
    requerirRol('admin'),
    validar({ params: ParamsId, body: GuardarFlotaBody }),
    idempotente(),
    async (req, res) => {
      const { nombre, maxActivos } = req.body as GuardarFlotaBody;
      res.json(await casos.guardarFlota({ id: params(req), nombre, maxActivos }));
    },
  );

  for (const [ruta, accion] of [
    ['habilitar', casos.habilitarChofer],
    ['deshabilitar', casos.deshabilitarChofer],
  ] as const) {
    r.post(
      `/admin/choferes/:id/${ruta}`,
      requerirRol('admin'),
      validar({ params: ParamsId, body: SinBody }),
      idempotente(),
      async (req, res) => {
        res.json(await accion(params(req)));
      },
    );
  }

  // --- Admin de flota: siempre la flota del token ---

  r.get('/flota', requerirRol('admin_flota'), async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await casos.flotaPropia(usuarioDe(req)));
  });

  r.get('/flota/choferes', requerirRol('admin_flota'), validar({ query: ListadoChoferesQuery }), async (req, res) => {
    const { limite, desde } = req.query as unknown as ListadoChoferesQuery;
    res.set('Cache-Control', 'no-store').json(await casos.listarChoferes(usuarioDe(req), { limite, desde }));
  });

  r.get('/flota/choferes/:id', requerirRol('admin_flota'), validar({ params: ParamsId }), async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await casos.obtenerChofer(usuarioDe(req), params(req)));
  });

  r.post(
    '/flota/choferes',
    requerirRol('admin_flota'),
    exigirFlota,
    validar({ body: AltaChoferBody }),
    idempotente(201, { alcance: porUsuarioYFlota }),
    async (req, res) => {
      res.status(201).json(await casos.altaChofer(usuarioDe(req), req.body as AltaChoferBody));
    },
  );

  for (const [ruta, accion] of [
    ['activar', casos.activarChofer],
    ['desactivar', casos.desactivarChofer],
  ] as const) {
    r.post(
      `/flota/choferes/:id/${ruta}`,
      requerirRol('admin_flota'),
      exigirFlota,
      validar({ params: ParamsId, body: SinBody }),
      idempotente(200, { alcance: porUsuarioYFlota }),
      async (req, res) => {
        res.json(await accion(usuarioDe(req), params(req)));
      },
    );
  }

  // --- Chofer: su propio registro ---

  r.put('/chofer/disponibilidad', requerirRol('chofer'), validar({ body: DisponibilidadBody }), idempotente(), async (req, res) => {
    res.json(await casos.cambiarDisponibilidad(usuarioDe(req).id, (req.body as DisponibilidadBody).disponible));
  });
}
