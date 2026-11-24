import { useState } from 'react';

/**
 * Un código (un UUID) para pasarle a otra persona: el chofer se lo da al admin de su flota para el
 * alta. Si el portapapeles no está disponible, el código igual queda seleccionable.
 */
export function CopiarCodigo({ codigo, abreviado = false }: { codigo: string; abreviado?: boolean }) {
  const [copiado, setCopiado] = useState(false);
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(codigo);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    } catch {
      // Sin permiso para el portapapeles: se copia a mano.
    }
  };
  return (
    <span className="codigo">
      <code title={codigo}>{abreviado ? `${codigo.slice(0, 8)}…` : codigo}</code>
      <button type="button" className="secundario" onClick={() => void copiar()}>
        {copiado ? 'Copiado' : 'Copiar'}
      </button>
    </span>
  );
}
