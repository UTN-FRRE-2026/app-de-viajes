// Genera las credenciales SOLO de carga en carga/.secretos/ (ignorado por git):
//   carga.env    contraseña del Postgres de carga y token de servicio de carga
//   jwks.json    clave pública de carga (la sirve el contenedor jwks)
//   tokens.json  500 access tokens de chofer firmados con la clave privada de carga
//   tokens-solicitudes.json  un pasajero y un chofer (carga/carrera.ps1 usa el pasajero)
//   tokens-viajes.json       600 pasajeros y 310 choferes de prueba para los viajes en paralelo
//                            (carga/solicitudes.js y carga/estres.js); los choferes, con su tipo según
//                            carga/flotas.sql: 300 aptos y 10 no aptos
// Nunca usa la clave de identity ni el .env del proyecto, y nunca imprime secretos ni tokens.
// Si las credenciales existen y los tokens vencen en más de 2 h, las conserva.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const CHOFERES = 500;
const VIDA_TOKENS_S = 6 * 3600;
const dir = fileURLToPath(new URL('./.secretos/', import.meta.url));
const ruta = (n) => `${dir}${n}`;

// Primero, confirmar que la carpeta está ignorada por git: si no, no se genera nada.
try {
  execFileSync('git', ['check-ignore', '-q', 'carga/.secretos/tokens.json'], { cwd: fileURLToPath(new URL('..', import.meta.url)) });
} catch {
  console.error('carga/.secretos/ no está en .gitignore: no genero credenciales.');
  process.exit(1);
}

const vigentes = () => {
  if (!['carga.env', 'jwks.json', 'tokens.json', 'tokens-solicitudes.json', 'tokens-viajes.json'].every((n) => existsSync(ruta(n)))) return false;
  const [primero] = JSON.parse(readFileSync(ruta('tokens.json'), 'utf8'));
  const exp = JSON.parse(Buffer.from(primero.split('.')[1], 'base64url').toString()).exp;
  return exp * 1000 - Date.now() > 2 * 3600 * 1000;
};

if (vigentes()) {
  console.log('Credenciales de carga vigentes en carga/.secretos/: no se regeneran.');
  process.exit(0);
}

mkdirSync(dir, { recursive: true });
const secreto = () => randomBytes(32).toString('base64url');
writeFileSync(ruta('carga.env'), `CARGA_PG_PASSWORD=${secreto()}\nCARGA_TOKEN_SERVICIO=${secreto()}\n`);

const { publicKey, privateKey } = await generateKeyPair('RS256');
const kid = `carga-${randomBytes(4).toString('hex')}`;
writeFileSync(ruta('jwks.json'), JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }] }));

const ahora = Math.floor(Date.now() / 1000);
const tokens = [];
for (let i = 1; i <= CHOFERES; i++) {
  const sub = `00000000-0000-4000-8000-c0000000${i.toString(16).padStart(4, '0')}`;
  tokens.push(
    await new SignJWT({ rol: 'chofer' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setSubject(sub)
      .setIssuer('viajes-carga')
      .setAudience('viajes-carga')
      .setIssuedAt(ahora)
      .setExpirationTime(ahora + VIDA_TOKENS_S)
      .sign(privateKey),
  );
}
writeFileSync(ruta('tokens.json'), JSON.stringify(tokens));

// La solicitud real (carga/solicitudes.js): un pasajero y un chofer dedicados, con ids que no se cruzan
// con los 500 choferes de k6. Mismos issuer, audience y clave de carga.
const firmar = (sub, rol) =>
  new SignJWT({ rol })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setSubject(sub)
    .setIssuer('viajes-carga')
    .setAudience('viajes-carga')
    .setIssuedAt(ahora)
    .setExpirationTime(ahora + VIDA_TOKENS_S)
    .sign(privateKey);
const pasajeroId = '00000000-0000-4000-8000-a00000000001';
const choferId = '00000000-0000-4000-8000-b00000000001';
writeFileSync(
  ruta('tokens-solicitudes.json'),
  JSON.stringify({ pasajeroId, pasajero: await firmar(pasajeroId, 'pasajero'), choferId, chofer: await firmar(choferId, 'chofer') }),
);
// Viajes en paralelo: pasajeros a0000000XXXX y choferes b0000000XXXX (hex). Los tipos de chofer son los
// de carga/flotas.sql: 1 a 300 aptos; 301-304 inactivos, 305-307 no disponibles, 308-310 de una flota
// que no opera en Córdoba. Los no aptos informan posición y escuchan su SSE: nunca deberían recibir ofertas.
const PASAJEROS_VIAJES = 600;
const CHOFERES_VIAJES = 310;
const tipoChofer = (i) => (i <= 300 ? 'apto' : i <= 304 ? 'inactivo' : i <= 307 ? 'no_disponible' : 'otra_zona');
const hex = (i) => i.toString(16).padStart(4, '0');
const pasajerosViajes = [];
for (let i = 1; i <= PASAJEROS_VIAJES; i++) {
  const id = `00000000-0000-4000-8000-a0000000${hex(i)}`;
  pasajerosViajes.push({ id, token: await firmar(id, 'pasajero') });
}
const choferesViajes = [];
for (let i = 1; i <= CHOFERES_VIAJES; i++) {
  const id = `00000000-0000-4000-8000-b0000000${hex(i)}`;
  choferesViajes.push({ id, tipo: tipoChofer(i), token: await firmar(id, 'chofer') });
}
writeFileSync(ruta('tokens-viajes.json'), JSON.stringify({ pasajeros: pasajerosViajes, choferes: choferesViajes }));

console.log(`Credenciales de carga generadas en carga/.secretos/: ${tokens.length} tokens de chofer, ${PASAJEROS_VIAJES} pasajeros y ${CHOFERES_VIAJES} choferes de prueba (vencen en ${VIDA_TOKENS_S / 3600} h).`);
