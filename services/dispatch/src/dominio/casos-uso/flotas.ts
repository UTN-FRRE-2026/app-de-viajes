import {
  ChoferNoEncontrado,
  ChoferYaRegistrado,
  CuentaNoEsChofer,
  FlotaNoEncontrada,
  LimiteFlotaAlcanzado,
  LimiteMenorQueActivos,
  PatenteYaRegistrada,
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
import type { DirectorioUsuarios, Pagina, RepositorioFlotas, TransaccionFlotas } from '../puertos/index.js';

export interface DependenciasFlotas {
  repoFlotas: RepositorioFlotas;
  directorio: DirectorioUsuarios;
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
export function crearCasosDeFlotas({ repoFlotas, directorio }: DependenciasFlotas) {
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
