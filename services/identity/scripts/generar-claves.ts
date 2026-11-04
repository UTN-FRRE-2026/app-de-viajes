// Genera la clave privada RS256 de desarrollo y la agrega al .env raíz.
// Nunca la imprime y nunca reemplaza una clave que ya esté cargada.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VARIABLE = 'IDENTITY_JWT_CLAVE_PRIVADA_B64';
const rutaEnv = fileURLToPath(new URL('../../../.env', import.meta.url));

if (!existsSync(rutaEnv)) {
  console.error('No existe .env en la raíz del repo. Copiá .env.example a .env y volvé a correr este comando.');
  process.exit(1);
}

const contenido = readFileSync(rutaEnv, 'utf8');
const linea = new RegExp(`^${VARIABLE}=(.*?)\\r?$`, 'm');

if (linea.exec(contenido)?.[1]) {
  console.log(`${VARIABLE} ya tiene un valor: no se modificó .env.`);
  process.exit(0);
}

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const valor = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
const nueva = `${VARIABLE}=${valor}`;

writeFileSync(
  rutaEnv,
  linea.test(contenido) ? contenido.replace(linea, nueva) : `${contenido.trimEnd()}\n${nueva}\n`,
);
console.log(`Clave RSA de 2048 bits agregada a .env en ${VARIABLE}.`);
