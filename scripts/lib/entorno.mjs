// Utilidades compartidas por setup.mjs y servicios.mjs. Solo Node (sin bash): andan en Windows y Linux.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RAIZ = fileURLToPath(new URL('../..', import.meta.url));
export const RUTA_ENV = fileURLToPath(new URL('../../.env', import.meta.url));
export const RUTA_EJEMPLO = fileURLToPath(new URL('../../.env.example', import.meta.url));

/** Los tres servicios, en el orden en que conviene arrancarlos (identity sirve el JWKS). */
export const SERVICIOS = [
  { nombre: 'identity', puerto: 3001 },
  { nombre: 'location', puerto: 3004 },
  { nombre: 'dispatch', puerto: 3005 },
];

const LINEA = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** Lee un .env: `CLAVE=valor` por línea, sin comillas ni expansión (igual que scripts/local.ps1). */
export function parsearEnv(texto) {
  const valores = {};
  for (const linea of texto.split(/\r?\n/)) {
    const m = LINEA.exec(linea);
    if (m) valores[m[1]] = m[2];
  }
  return valores;
}

export function leerEnv(ruta = RUTA_ENV) {
  return existsSync(ruta) ? parsearEnv(readFileSync(ruta, 'utf8')) : {};
}

/**
 * Agrega al .env las variables de .env.example que le faltan, con su comentario, sin tocar las que
 * ya están. Así un .env viejo se pone al día cuando entra un servicio o una variable nueva.
 * Devuelve el texto nuevo y los nombres agregados.
 */
export function completarEnv(textoActual, textoEjemplo) {
  const actuales = parsearEnv(textoActual);
  const agregadas = [];
  const bloques = [];
  let comentarios = [];
  for (const linea of textoEjemplo.split(/\r?\n/)) {
    if (linea.startsWith('#')) {
      comentarios.push(linea);
      continue;
    }
    const m = LINEA.exec(linea);
    if (m && !(m[1] in actuales)) {
      agregadas.push(m[1]);
      bloques.push(...comentarios, linea);
    }
    comentarios = [];
  }
  if (agregadas.length === 0) return { texto: textoActual, agregadas };
  const fin = textoActual.endsWith('\n') || textoActual === '' ? '' : '\n';
  const separador = textoActual === '' ? '' : '\n# --- Agregadas por npm run setup desde .env.example ---\n';
  return { texto: `${textoActual}${fin}${separador}${bloques.join('\n')}\n`, agregadas };
}

/**
 * El entorno de un proceso hijo: lo que ya trae el proceso pisa al .env (como dotenv), así se puede
 * cambiar una variable en la terminal sin editar el archivo.
 */
export function entornoCon(env = leerEnv(), extra = {}) {
  return { ...env, ...process.env, ...extra };
}

/** En Windows npm y npx son .cmd: hacen falta con shell. En Linux no. */
const conShell = process.platform === 'win32';

/**
 * Corre un comando y espera. Lanza un error con el comando si termina mal.
 * Los argumentos no pueden llevar espacios (en Windows van por shell sin escapar): lo que tenga
 * espacios, como SQL, va por `entrada` (stdin).
 */
export function correr(comando, args, { env, cwd = RAIZ, silencioso = false, entrada } = {}) {
  const r = spawnSync(comando, args, {
    cwd,
    env,
    shell: conShell,
    input: entrada,
    stdio: [entrada === undefined ? 'inherit' : 'pipe', silencioso ? 'pipe' : 'inherit', silencioso ? 'pipe' : 'inherit'],
    encoding: 'utf8',
  });
  if (r.error) throw new Error(`no se pudo ejecutar «${comando}»: ${r.error.message}`);
  if (r.status !== 0) {
    const detalle = silencioso ? `\n${(r.stderr || r.stdout || '').trim()}` : '';
    throw new Error(`«${[comando, ...args].join(' ')}» terminó con código ${r.status}${detalle}`);
  }
  return r.stdout ?? '';
}
