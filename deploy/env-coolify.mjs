// node deploy/env-coolify.mjs
//
// Arma deploy/.env.coolify con las variables que necesita docker-compose.coolify.yml, sacadas de
// deploy/.env.produccion (node deploy/preparar-env.mjs <dominio>). Su contenido se pega en Coolify:
// Environment Variables → Developer view. No imprime ningún secreto; el archivo no se versiona (.env.*).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { leerEnv } from '../scripts/lib/entorno.mjs';
import { RUTA_PRODUCCION } from './preparar-env.mjs';

const RUTA_COOLIFY = fileURLToPath(new URL('./.env.coolify', import.meta.url));
const RUTA_COMPOSE = fileURLToPath(new URL('../docker-compose.coolify.yml', import.meta.url));

/** Las obligatorias del compose: las ${VAR:?}. Se leen del archivo, para que no queden desalineadas. */
export function obligatorias(textoCompose) {
  return [...new Set([...textoCompose.matchAll(/\$\{([A-Z0-9_]+):\?\}/g)].map((m) => m[1]))];
}

const esPrincipal = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (esPrincipal) {
  if (!existsSync(RUTA_PRODUCCION)) {
    console.error('Falta deploy/.env.produccion: correr antes node deploy/preparar-env.mjs <dominio>');
    process.exit(1);
  }
  const valores = leerEnv(RUTA_PRODUCCION);
  const nombres = obligatorias(readFileSync(RUTA_COMPOSE, 'utf8'));
  const faltan = nombres.filter((n) => !valores[n]);
  if (faltan.length > 0) {
    console.error(`deploy/.env.produccion no tiene: ${faltan.join(', ')}`);
    process.exit(1);
  }
  // Opcionales: las credenciales de Grafana Cloud (Alloy), solo si están completas en .env.produccion.
  const grafana = Object.keys(valores).filter((n) => n.startsWith('GRAFANA_CLOUD_') && valores[n]);
  const todas = [...nombres, ...grafana.filter((n) => !nombres.includes(n))];
  writeFileSync(RUTA_COOLIFY, `${todas.map((n) => `${n}=${valores[n]}`).join('\n')}\n`, { mode: 0o600 });
  console.log(`deploy/.env.coolify creado con ${todas.length} variables (${todas.join(', ')}).`);
  if (grafana.length < 5) {
    console.log('Sin las cinco GRAFANA_CLOUD_* completas: Alloy arranca pero no envía nada (docs/observabilidad.md).');
  }
  console.log('Pegar su contenido en Coolify: Environment Variables → Developer view. No se muestra acá.');
}
