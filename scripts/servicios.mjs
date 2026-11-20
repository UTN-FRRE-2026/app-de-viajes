// Levanta identity, location y dispatch en una sola terminal, con el .env cargado y cada uno en su
// puerto. La salida de cada servicio va con su nombre adelante.
//
//   node scripts/servicios.mjs dev     con recarga (tsx watch, sobre el código fuente)
//   node scripts/servicios.mjs start   lo compilado (dist/); `npm start` compila antes
//
// Ctrl+C los apaga a los tres en orden (SIGTERM: cada uno drena sus pedidos).
//
// Si un servicio se cae:
// - en `start`, se apagan los otros dos y se sale con error: mejor ver la falla que quedarse con dos
//   de tres;
// - en `dev`, tsx watch sigue vivo y lo reinicia al guardar un archivo (es lo que se quiere mientras
//   se programa), así que no se apaga nada. Para que no pase desapercibido, se consulta /health de
//   cada servicio y se avisa cuando deja de responder y cuando vuelve.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { entornoCon, leerEnv, RAIZ, RUTA_ENV, SERVICIOS } from './lib/entorno.mjs';

const modo = process.argv[2];
if (modo !== 'dev' && modo !== 'start') {
  console.error('Uso: node scripts/servicios.mjs dev|start');
  process.exit(2);
}
if (!existsSync(RUTA_ENV)) {
  console.error('No hay .env en la raíz del repo. Corré primero: npm run setup');
  process.exit(1);
}

const COLORES = ['\x1b[36m', '\x1b[35m', '\x1b[33m'];
const RESET = '\x1b[0m';
const ancho = Math.max(...SERVICIOS.map((s) => s.nombre.length));
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

function puertoLibre(puerto) {
  return new Promise((resolver) => {
    const s = createServer();
    s.once('error', () => resolver(false));
    s.listen(puerto, () => s.close(() => resolver(true)));
  });
}

/** Antepone el nombre del servicio a cada línea, sin cortar líneas que llegan en dos pedazos. */
function conPrefijo(destino, nombre, color) {
  const prefijo = `${process.stdout.isTTY ? color : ''}${nombre.padEnd(ancho)} |${process.stdout.isTTY ? RESET : ''} `;
  let resto = '';
  return {
    escribir(parte) {
      const lineas = (resto + parte.toString()).split(/\r?\n/);
      resto = lineas.pop() ?? '';
      for (const l of lineas) destino.write(`${prefijo}${l}\n`);
    },
    vaciar() {
      if (resto) destino.write(`${prefijo}${resto}\n`);
      resto = '';
    },
  };
}

function argumentos(nombre) {
  const carpeta = join(RAIZ, 'services', nombre);
  if (modo === 'dev') {
    // tsx con node directo (sin npm ni shell): así la señal de apagado llega al proceso correcto.
    return { carpeta, args: [tsxCli, 'watch', '--conditions=development', 'src/servidor.ts'] };
  }
  const entrada = join(carpeta, 'dist', 'servidor.js');
  if (!existsSync(entrada)) throw new Error(`falta ${entrada}. Compilá con npm run build (npm start ya lo hace).`);
  return { carpeta, args: [entrada] };
}

const ocupados = [];
for (const { nombre, puerto } of SERVICIOS) if (!(await puertoLibre(puerto))) ocupados.push(`${nombre} (${puerto})`);
if (ocupados.length) {
  console.error(
    `Puertos ocupados: ${ocupados.join(', ')}. ¿Están corriendo los contenedores? ` +
      'Paralos con: docker compose stop identity location dispatch',
  );
  process.exit(1);
}

const env = leerEnv();
const hijos = [];
let apagando = false;
let codigoSalida = 0;

for (const [i, { nombre, puerto }] of SERVICIOS.entries()) {
  const { carpeta, args } = argumentos(nombre);
  const salida = conPrefijo(process.stdout, nombre, COLORES[i % COLORES.length]);
  const errores = conPrefijo(process.stderr, nombre, COLORES[i % COLORES.length]);
  const hijo = spawn(process.execPath, args, {
    cwd: carpeta,
    // PUERTO siempre el del servicio, aunque venga otro del entorno: si no, chocarían entre sí.
    env: entornoCon(env, { PUERTO: String(puerto) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hijo.stdout.on('data', (d) => salida.escribir(d));
  hijo.stderr.on('data', (d) => errores.escribir(d));
  hijo.on('exit', (codigo, senal) => {
    salida.vaciar();
    errores.vaciar();
    hijos.splice(hijos.indexOf(hijo), 1);
    if (!apagando) {
      console.error(`\n${nombre} terminó solo (${senal ?? `código ${codigo}`}): apago los demás.`);
      codigoSalida = 1;
      apagar();
    }
    if (hijos.length === 0) process.exit(codigoSalida);
  });
  hijos.push(hijo);
}

/**
 * Solo en dev: tsx watch no termina cuando el servidor se cae, así que el `exit` de arriba no se
 * entera. Se vigila /health: un aviso al caerse (con la causa en las líneas de arriba) y otro al volver.
 */
const VIGILANCIA_MS = 2000;
const ESPERA_ARRANQUE_MS = 60_000;
async function responde(puerto) {
  try {
    return (await fetch(`http://127.0.0.1:${puerto}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}
if (modo === 'dev') {
  const inicio = Date.now();
  const estado = new Map(SERVICIOS.map((s) => [s.nombre, 'arrancando']));
  const vigilar = setInterval(async () => {
    if (apagando) return clearInterval(vigilar);
    for (const { nombre, puerto } of SERVICIOS) {
      const ok = await responde(puerto);
      const antes = estado.get(nombre);
      if (apagando) return;
      if (ok && antes !== 'arriba') {
        if (antes === 'caido') console.error(`\n>>> ${nombre} volvió a responder en ${puerto}.\n`);
        estado.set(nombre, 'arriba');
      } else if (!ok && antes === 'arriba') {
        console.error(
          `\n>>> ${nombre} dejó de responder en ${puerto}. La causa está arriba, en sus líneas. ` +
            'Corregí y guardá: tsx lo reinicia. Los otros servicios siguen.\n',
        );
        estado.set(nombre, 'caido');
      } else if (!ok && antes === 'arrancando' && Date.now() - inicio > ESPERA_ARRANQUE_MS) {
        console.error(`\n>>> ${nombre} no arrancó en ${ESPERA_ARRANQUE_MS / 1000} s. La causa está arriba, en sus líneas.\n`);
        estado.set(nombre, 'caido');
      }
    }
  }, VIGILANCIA_MS);
  vigilar.unref();
}

/**
 * `ctrlC`: en Windows, Ctrl+C ya les llega a los hijos por la consola compartida y cada uno se apaga
 * ordenado; no hay que hacer nada más que esperar. En Windows no existe SIGTERM entre procesos, así
 * que si hay que apagarlos por otro motivo (uno se cayó), se corta el árbol con taskkill.
 */
function apagar(ctrlC = false) {
  if (apagando) return;
  apagando = true;
  for (const h of hijos) {
    if (process.platform !== 'win32') h.kill('SIGTERM');
    else if (!ctrlC) spawnSync('taskkill', ['/pid', String(h.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  // Si alguno no termina (apagado colgado), no dejar la terminal tomada.
  setTimeout(() => process.exit(1), 15_000).unref();
}

process.on('SIGINT', () => apagar(true));
process.on('SIGTERM', () => apagar());
