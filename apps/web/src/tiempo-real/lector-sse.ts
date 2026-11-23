/** Un mensaje completo del stream: `event:` (o `message`), las líneas de `data:` unidas e `id:`, si vino. */
export interface MensajeSse {
  evento: string;
  datos: string;
  id: string | null;
}

/**
 * Lee `text/event-stream` en pedazos, como llegan de la red (un mensaje puede venir partido en varios,
 * o varios en uno). Sigue el formato de la especificación: fin de línea `\n`, `\r\n` o `\r`; los
 * comentarios (`: latido`) se ignoran; `retry:` cambia la espera para reconectar.
 */
export class LectorSse {
  private resto = '';
  private evento = '';
  private datos: string[] = [];
  private id: string | null = null;
  /** El último `retry:` recibido, en milisegundos. */
  retry: number | null = null;

  agregar(texto: string): MensajeSse[] {
    this.resto += texto;
    const mensajes: MensajeSse[] = [];
    for (;;) {
      const fin = /\r\n|\r|\n/.exec(this.resto);
      if (!fin) break;
      // Un `\r` al final puede ser la primera mitad de un `\r\n` que llega en el próximo pedazo.
      if (fin[0] === '\r' && fin.index === this.resto.length - 1) break;
      const linea = this.resto.slice(0, fin.index);
      this.resto = this.resto.slice(fin.index + fin[0].length);
      const mensaje = this.procesar(linea);
      if (mensaje) mensajes.push(mensaje);
    }
    return mensajes;
  }

  private procesar(linea: string): MensajeSse | null {
    if (linea === '') {
      // Línea vacía: termina el mensaje. Sin `data:` no hay nada que entregar.
      const mensaje = this.datos.length > 0 ? { evento: this.evento || 'message', datos: this.datos.join('\n'), id: this.id } : null;
      this.evento = '';
      this.datos = [];
      this.id = null;
      return mensaje;
    }
    if (linea.startsWith(':')) return null;
    const dosPuntos = linea.indexOf(':');
    const campo = dosPuntos < 0 ? linea : linea.slice(0, dosPuntos);
    let valor = dosPuntos < 0 ? '' : linea.slice(dosPuntos + 1);
    if (valor.startsWith(' ')) valor = valor.slice(1);
    if (campo === 'event') this.evento = valor;
    else if (campo === 'data') this.datos.push(valor);
    else if (campo === 'id' && !valor.includes('\0')) this.id = valor;
    else if (campo === 'retry' && /^\d+$/.test(valor)) this.retry = Number(valor);
    return null;
  }
}
