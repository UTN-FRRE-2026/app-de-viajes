import {
  ChoferNoEncontrado,
  ChoferYaRegistrado,
  CuentaNoEsChofer,
  FlotaNoEncontrada,
  LimiteFlotaAlcanzado,
  LimiteMenorQueActivos,
  PatenteYaRegistrada,
  ZonaInvalida,
  ZonaNoEncontrada,
  ZonasSuperpuestas,
} from '../errores/index.js';
import {
  ChoferFlota,
  exigirMismaFlota,
  flotaDelActor,
  type ActorFlota,
  type DatosChoferFlota,
  type DatosFlota,
  type Flota,
  type Vehiculo,
} from '../flotas/index.js';
import type {
  DatosReporteFlota,
  DatosZona,
  DirectorioUsuarios,
  ElegibilidadChoferes,
  Pagina,
  PeriodoReporte,
  RepositorioDespacho,
  RepositorioFlotas,
  TransaccionFlotas,
} from '../puertos/index.js';

export interface DependenciasFlotas {
  repoFlotas: RepositorioFlotas;
  directorio: DirectorioUsuarios;
  /** Los viajes y los cobros, para el reporte: viven en el repositorio de despacho. */
  viajes: Pick<RepositorioDespacho, 'reporteFlota'>;
  /** Para avisar al caché de zonas, después del COMMIT, que cambiaron las zonas o las de una flota. */
  elegibilidad?: Pick<ElegibilidadChoferes, 'zonasCambiadas'>;
}

/** El reporte de la flota, con el período que se consultó. */
export interface ReporteFlota extends DatosReporteFlota {
  flotaId: string;
  inicio: string;
  fin: string;
  moneda: 'ARS';
  /** Solo los cobros APROBADO; los pendientes y los rechazados no se facturan. */
  facturadoCentavos: number;
}

export interface ListadoChoferes {
  choferes: DatosChoferFlota[];
  /** Valor de `desde` para pedir la página siguiente, o null si no hay más. */
  siguiente: number | null;
}

/**
 * Casos de uso de flotas. El alcance se valida acá, no en la ruta: el `fleetId` sale del token del
 * admin_flota y cada operación sobre un chofer comprueba que sea de esa flota (404 si no).
 *
 * Qué mueve el cupo:
 * - activar a un chofer inactivo **ocupa** uno (UPDATE condicional; 409 si la flota está llena);
 * - desactivarlo, o que el admin lo deshabilite, **libera** uno;
 * - activar a uno ya activo, cambiar la disponibilidad o bajar el límite no lo tocan.
 * El cambio del chofer y el del contador van en la misma transacción.
 */
export function crearCasosDeFlotas({ repoFlotas, directorio, viajes, elegibilidad }: DependenciasFlotas) {
  /** Después del COMMIT: el próximo pedido ve el cambio. No lanza (la implementación no lanza). */
  const zonasCambiadas = async () => {
    await elegibilidad?.zonasCambiadas?.();
  };

  /** La flota del token tiene que existir en dispatch. */
  async function flotaPropia(actor: ActorFlota): Promise<Flota> {
    const flota = await repoFlotas.obtenerFlota(flotaDelActor(actor));
    if (!flota) throw new FlotaNoEncontrada();
    return flota;
  }

  /** Lee y bloquea el chofer, y exige que sea de la flota del actor. */
  async function choferDeLaFlota(tx: TransaccionFlotas, actor: ActorFlota, choferId: string): Promise<ChoferFlota> {
    return exigirMismaFlota(await tx.obtenerChoferParaActualizar(choferId), flotaDelActor(actor));
  }

  /** Guarda el chofer y, si dejó de estar activo, libera su cupo en la misma transacción. */
  async function guardarYLiberar(tx: TransaccionFlotas, chofer: ChoferFlota, liberaCupo: boolean) {
    await tx.guardarChofer(chofer);
    if (liberaCupo) await tx.liberarCupo(chofer.flotaId);
  }

  return {
    flotaPropia,

    /** Admin de la plataforma: crea la flota o cambia su nombre y su límite. */
    async guardarFlota(datos: DatosFlota): Promise<Flota> {
      return repoFlotas.enTransaccion(async (tx) => {
        if ((await tx.guardarFlota(datos)) === 'limite_menor') throw new LimiteMenorQueActivos();
        return (await tx.obtenerFlota(datos.id)) as Flota;
      });
    },

    async listarChoferes(actor: ActorFlota, { limite, desde }: Pagina): Promise<ListadoChoferes> {
      const flota = await flotaPropia(actor);
      const filas = await repoFlotas.listarChoferes(flota.id, { limite: limite + 1, desde });
      return {
        choferes: filas.slice(0, limite).map((c) => c.aDatos()),
        siguiente: filas.length > limite ? desde + limite : null,
      };
    },

    /**
     * Viajes y facturación de la flota del token en [inicio, fin), sobre el inicio de cada viaje. Cuenta
     * por la flota guardada en el viaje al aceptar (los viajes sin flota quedan fuera) y factura solo
     * los cobros aprobados. Un período sin viajes da ceros.
     */
    async reporte(actor: ActorFlota, periodo: PeriodoReporte): Promise<ReporteFlota> {
      const flota = await flotaPropia(actor);
      const datos = await viajes.reporteFlota(flota.id, periodo);
      return {
        flotaId: flota.id,
        inicio: periodo.inicio.toISOString(),
        fin: periodo.fin.toISOString(),
        moneda: 'ARS',
        viajesCompletados: datos.viajesCompletados,
        facturadoCentavos: datos.cobros.aprobados.centavos,
        cobros: datos.cobros,
      };
    },

    async obtenerChofer(actor: ActorFlota, choferId: string): Promise<DatosChoferFlota> {
      const flota = await flotaPropia(actor);
      return exigirMismaFlota(await repoFlotas.obtenerChofer(choferId), flota.id).aDatos();
    },

    /**
     * Alta de un chofer en la flota del admin_flota, deshabilitado e inactivo. El `choferId` tiene que
     * ser una cuenta real de identity con rol `chofer`: se pregunta antes de abrir la transacción.
     */
    async altaChofer(actor: ActorFlota, { choferId, vehiculo }: { choferId: string; vehiculo: Vehiculo }) {
      const flota = await flotaPropia(actor);
      if ((await directorio.rolDe(choferId)) !== 'chofer') throw new CuentaNoEsChofer();
      return repoFlotas.enTransaccion(async (tx) => {
        const chofer = ChoferFlota.nuevo(choferId, flota.id, vehiculo);
        const resultado = await tx.insertarChofer(chofer);
        if (resultado === 'chofer_existe') throw new ChoferYaRegistrado();
        if (resultado === 'patente_existe') throw new PatenteYaRegistrada();
        return chofer.aDatos();
      });
    },

    /**
     * Admin de la plataforma: crea o cambia una zona operativa. Las zonas no se superponen (409); un
     * polígono que PostGIS no acepta da 422. Cambiar el polígono no mueve las solicitudes ya creadas:
     * cada una guardó su zona al crearse.
     */
    async guardarZona(zona: DatosZona): Promise<DatosZona> {
      const guardada = await repoFlotas.enTransaccion(async (tx) => {
        const r = await tx.guardarZona(zona);
        if (r.resultado === 'invalida') throw new ZonaInvalida(r.motivo);
        if (r.resultado === 'superpuesta') throw new ZonasSuperpuestas(r.con);
        return (await tx.obtenerZona(zona.id)) as DatosZona;
      });
      await zonasCambiadas();
      return guardada;
    },

    listarZonas: () => repoFlotas.listarZonas(),

    /**
     * Admin de la plataforma: las zonas donde opera la flota (reemplaza las anteriores). Quitar una zona
     * espera a las aceptaciones en curso que la usan; desde que confirma, sus choferes no reciben ni
     * pueden aceptar ofertas de esa zona.
     */
    async zonasDeFlota(flotaId: string, zonas: readonly string[]): Promise<{ flotaId: string; zonas: string[] }> {
      const resultado = await repoFlotas.enTransaccion(async (tx) => {
        const r = await tx.reemplazarZonasDeFlota(flotaId, zonas);
        if (r === 'flota_no_existe') throw new FlotaNoEncontrada();
        if (r === 'zona_no_existe') throw new ZonaNoEncontrada();
        return { flotaId, zonas: await tx.zonasDeFlota(flotaId) };
      });
      await zonasCambiadas();
      return resultado;
    },

    /** Admin de la plataforma: habilita a cualquier chofer. */
    async habilitarChofer(choferId: string): Promise<DatosChoferFlota> {
      return repoFlotas.enTransaccion(async (tx) => {
        const chofer = await tx.obtenerChoferParaActualizar(choferId);
        if (!chofer) throw new ChoferNoEncontrado();
        chofer.habilitar();
        await tx.guardarChofer(chofer);
        return chofer.aDatos();
      });
    },

    /** Admin de la plataforma: si el chofer estaba activo, libera su cupo en la misma transacción. */
    async deshabilitarChofer(choferId: string): Promise<DatosChoferFlota> {
      return repoFlotas.enTransaccion(async (tx) => {
        const chofer = await tx.obtenerChoferParaActualizar(choferId);
        if (!chofer) throw new ChoferNoEncontrado();
        await guardarYLiberar(tx, chofer, chofer.deshabilitar());
        return chofer.aDatos();
      });
    },

    /**
     * Carrera G. Bloquea al chofer y, solo si pasa de inactivo a activo, ocupa un cupo con el UPDATE
     * condicional de la flota. Todo en una transacción: si la flota está llena, el chofer no queda activo.
     */
    async activarChofer(actor: ActorFlota, choferId: string): Promise<DatosChoferFlota> {
      return repoFlotas.enTransaccion(async (tx) => {
        const chofer = await choferDeLaFlota(tx, actor, choferId);
        if (chofer.activar() === 'ocupa_cupo') {
          if (!(await tx.ocuparCupo(chofer.flotaId))) throw new LimiteFlotaAlcanzado();
          await tx.guardarChofer(chofer);
        }
        return chofer.aDatos();
      });
    },

    async desactivarChofer(actor: ActorFlota, choferId: string): Promise<DatosChoferFlota> {
      return repoFlotas.enTransaccion(async (tx) => {
        const chofer = await choferDeLaFlota(tx, actor, choferId);
        await guardarYLiberar(tx, chofer, chofer.desactivar());
        return chofer.aDatos();
      });
    },

    /** El registro del chofer del token, o null si todavía no está en ninguna flota. */
    async registroPropio(choferId: string): Promise<DatosChoferFlota | null> {
      return (await repoFlotas.obtenerChofer(choferId))?.aDatos() ?? null;
    },

    /** El chofer del token, sobre su propio registro. */
    async cambiarDisponibilidad(choferId: string, disponible: boolean): Promise<DatosChoferFlota> {
      return repoFlotas.enTransaccion(async (tx) => {
        const chofer = await tx.obtenerChoferParaActualizar(choferId);
        if (!chofer) throw new ChoferNoEncontrado();
        chofer.cambiarDisponibilidad(disponible);
        await tx.guardarChofer(chofer);
        return chofer.aDatos();
      });
    },
  };
}

export type CasosDeFlotas = ReturnType<typeof crearCasosDeFlotas>;
