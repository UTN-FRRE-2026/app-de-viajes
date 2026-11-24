import { z } from 'zod';
import { Pagina } from './dispatch.js';

// Flotas (variante G). Lista blanca con `strictObject`: el body nunca trae la flota; sale del token
// del admin_flota. Un `fleetId`, `__proto__` o cualquier clave no declarada da 400.

/** Patente argentina: la vieja (`ABC123`) o la Mercosur (`AB123CD`). Se guarda en mayúsculas y sin espacios. */
export const Patente = z
  .string()
  .transform((p) => p.replace(/\s+/g, '').toUpperCase())
  .pipe(z.string().regex(/^(?:[A-Z]{3}\d{3}|[A-Z]{2}\d{3}[A-Z]{2})$/, 'patente inválida (ABC123 o AB123CD)'));

const Texto = (max: number) => z.string().trim().min(1).max(max);

export const Vehiculo = z.strictObject({ patente: Patente, marca: Texto(40), modelo: Texto(40) });
export type Vehiculo = z.infer<typeof Vehiculo>;

/** Tope del límite de una flota: acota el valor, no es una regla del negocio. */
export const MAX_ACTIVOS_TOPE = 10_000;

/** `PUT /admin/flotas/:id`: crea o actualiza la flota con el id que identity usa como `fleetId`. */
export const GuardarFlotaBody = z.strictObject({
  nombre: Texto(80),
  maxActivos: z.number().int().min(0).max(MAX_ACTIVOS_TOPE),
});
export type GuardarFlotaBody = z.infer<typeof GuardarFlotaBody>;

/** `POST /flota/choferes`: el chofer es una cuenta de identity con rol `chofer`. */
export const AltaChoferBody = z.strictObject({ choferId: z.uuid(), vehiculo: Vehiculo });
export type AltaChoferBody = z.infer<typeof AltaChoferBody>;

export const DisponibilidadBody = z.strictObject({ disponible: z.boolean() });
export type DisponibilidadBody = z.infer<typeof DisponibilidadBody>;

export const ListadoChoferesQuery = z.strictObject(Pagina);
export type ListadoChoferesQuery = z.infer<typeof ListadoChoferesQuery>;

export const FlotaRespuesta = z.strictObject({
  id: z.uuid(),
  nombre: z.string(),
  maxActivos: z.number().int(),
  activos: z.number().int(),
});
export type FlotaRespuesta = z.infer<typeof FlotaRespuesta>;

export const ChoferFlotaRespuesta = z.strictObject({
  id: z.uuid(),
  flotaId: z.uuid(),
  vehiculo: Vehiculo,
  habilitado: z.boolean(),
  activo: z.boolean(),
  disponible: z.boolean(),
});
export type ChoferFlotaRespuesta = z.infer<typeof ChoferFlotaRespuesta>;

// --- Zonas operativas (PR 2 de flotas) ---

/** Un punto GeoJSON: [lng, lat], en ese orden. */
const PosicionGeo = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

/** Tope de vértices de una zona: acota el trabajo de PostGIS por pedido, no es una regla del negocio. */
export const VERTICES_ZONA_MAX = 1000;

/**
 * Un `Polygon` de GeoJSON con solo el anillo exterior (sin huecos), cerrado: el primer punto se repite
 * al final. Que no se cruce consigo mismo lo decide PostGIS (`ST_IsValid`): 422 `ZONA_INVALIDA`.
 */
export const PoligonoZona = z.strictObject({
  type: z.literal('Polygon'),
  coordinates: z
    .tuple([z.array(PosicionGeo).min(4).max(VERTICES_ZONA_MAX)])
    .refine(([anillo]) => anillo[0]![0] === anillo.at(-1)![0] && anillo[0]![1] === anillo.at(-1)![1], {
      message: 'el anillo tiene que estar cerrado: el primer punto se repite al final',
    }),
});
export type PoligonoZona = z.infer<typeof PoligonoZona>;

/** `PUT /admin/zonas/:id`: crea o cambia una zona. */
export const GuardarZonaBody = z.strictObject({ nombre: Texto(80), area: PoligonoZona });
export type GuardarZonaBody = z.infer<typeof GuardarZonaBody>;

/** `PUT /admin/flotas/:id/zonas`: las zonas donde opera la flota (reemplaza las anteriores). */
export const ZonasDeFlotaBody = z.strictObject({ zonas: z.array(z.uuid()).max(100) });
export type ZonasDeFlotaBody = z.infer<typeof ZonasDeFlotaBody>;

export const ZonaRespuesta = z.strictObject({ id: z.uuid(), nombre: z.string(), area: PoligonoZona });
export type ZonaRespuesta = z.infer<typeof ZonaRespuesta>;

export const ZonasDeFlotaRespuesta = z.strictObject({ flotaId: z.uuid(), zonas: z.array(z.uuid()) });
export type ZonasDeFlotaRespuesta = z.infer<typeof ZonasDeFlotaRespuesta>;
