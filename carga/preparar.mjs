// Genera las credenciales SOLO de carga en carga/.secretos/ (ignorado por git):
//   carga.env    contraseña del Postgres de carga y token de servicio de carga
//   jwks.json    clave pública de carga (la sirve el contenedor jwks)
//   tokens.json  500 access tokens de chofer firmados con la clave privada de carga
//   tokens-solicitudes.json  un pasajero y un chofer para la solicitud real (carga/solicitudes.js)
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
  if (!['carga.env', 'jwks.json', 'tokens.json', 'tokens-solicitudes.json'].every((n) => existsSync(ruta(n)))) return false;
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
console.log(`Credenciales de carga generadas en carga/.secretos/: ${tokens.length} tokens de chofer (vencen en ${VIDA_TOKENS_S / 3600} h).`);
