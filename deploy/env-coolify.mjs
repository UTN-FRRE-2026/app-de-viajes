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
  writeFileSync(RUTA_COOLIFY, `${nombres.map((n) => `${n}=${valores[n]}`).join('\n')}\n`, { mode: 0o600 });
  console.log(`deploy/.env.coolify creado con ${nombres.length} variables (${nombres.join(', ')}).`);
  console.log('Pegar su contenido en Coolify: Environment Variables → Developer view. No se muestra acá.');
}
