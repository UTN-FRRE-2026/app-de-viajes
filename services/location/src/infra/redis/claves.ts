/**
 * Todas las claves de la versión optimizada, bajo un prefijo configurable (`location:` en el
 * entorno habitual, `carga:location:` en el de k6). Así nada de location pisa claves de identity, y la
 * limpieza del entorno de carga no puede tocar las del entorno habitual.
 */
export function clavesUbicacion(prefijo: string) {
  return {
    /** HASH choferId → "lat|lng|tsMs": las coordenadas ORIGINALES, sin cuantizar. */
    posiciones: `${prefijo}pos`,
    /** Índice GEO (solo para encontrar candidatos; sus coordenadas vienen cuantizadas). */
    geo: `${prefijo}geo`,
    /** ZSET choferId → tsMs de la última posición: vencimiento y purga. */
    vistos: `${prefijo}visto`,
    /** SET de choferes con |lat| > 85,05…, que Redis GEO no acepta. Normalmente vacío. */
    fueraGeo: `${prefijo}fuera-geo`,
    /** STREAM del historial pendiente de escribir en Postgres. */
    historial: `${prefijo}historial`,
    /** Contador de entradas que no entraron al historial porque la cola estaba llena. */
    descartados: `${prefijo}historial:descartados`,
  };
}

export type ClavesUbicacion = ReturnType<typeof clavesUbicacion>;

/** Grupo de consumidores del stream del historial. */
export const GRUPO_HISTORIAL = 'historial';
