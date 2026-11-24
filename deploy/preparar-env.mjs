// node deploy/preparar-env.mjs <dominio>
//
// Arma deploy/.env.produccion a partir de .env.example, con secretos nuevos: contraseñas de las bases,
// tokens de servicio y de métricas, la clave RS256 de identity y la contraseña de los usuarios de prueba.
// No imprime ningún secreto. Si el archivo ya existe, no lo toca (los datos ya creados dependen de esas
// contraseñas): para empezar de cero, borrarlo junto con el volumen de Postgres.
//
// <dominio>: el dominio del entorno publicado (HTTPS automático) o :80 (HTTP, detrás de un túnel con TLS).
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RUTA_EJEMPLO } from '../scripts/lib/entorno.mjs';

export const RUTA_PRODUCCION = fileURLToPath(new URL('./.env.produccion', import.meta.url));

const secreto = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Los valores que cambian respecto de .env.example. El resto queda como en desarrollo. */
export function valoresProduccion(dominio, puertoPostgres = process.env.POSTGRES_PUERTO_HOST || '5434') {
  const clave = {
    identity: secreto(24),
    location: secreto(24),
    dispatch: secreto(24),
  };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  // El host llega a Postgres por 127.0.0.1 (compose.produccion.yml); los contenedores, por la red interna.
  const url = (servicio) => `postgresql://${servicio}_svc:${clave[servicio]}@127.0.0.1:${puertoPostgres}/${servicio}`;
  return {
    DOMINIO: dominio,
    POSTGRES_PUERTO_HOST: puertoPostgres,
    POSTGRES_PASSWORD: secreto(24),
    DB_PASSWORD_IDENTITY: clave.identity,
    DB_PASSWORD_LOCATION: clave.location,
    DB_PASSWORD_DISPATCH: clave.dispatch,
    DATABASE_URL: url('dispatch'),
    IDENTITY_DATABASE_URL: url('identity'),
    LOCATION_DATABASE_URL: url('location'),
    METRICAS_TOKEN: secreto(),
    IDENTITY_TOKEN_SERVICIO: secreto(),
    LOCATION_TOKEN_SERVICIO: secreto(),
    DISPATCH_TOKEN_SERVICIO: secreto(),
    IDENTITY_JWT_CLAVE_PRIVADA_B64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
    // La de los usuarios de prueba: se les pasa a los grupos atacantes (docs/despliegue.md).
    IDENTITY_SEED_CONTRASENA: `Prueba-${secreto(9)}`,
    // La que aguanta 500 choferes (docs/mediciones.md).
    UBICACION_ESTRATEGIA: 'optimizada',
  };
}

/** Reemplaza en el texto de .env.example las variables dadas; las que no estén, las agrega al final. */
export function aplicar(textoEjemplo, valores) {
  const pendientes = new Map(Object.entries(valores));
  const lineas = textoEjemplo.split(/\r?\n/).map((linea) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(linea);
    if (!m || !pendientes.has(m[1])) return linea;
    const valor = pendientes.get(m[1]);
    pendientes.delete(m[1]);
    return `${m[1]}=${valor}`;
  });
  if (pendientes.size > 0) {
    lineas.push('', '# --- Entorno publicado (deploy/preparar-env.mjs) ---');
    for (const [k, v] of pendientes) lineas.push(`${k}=${v}`);
  }
  return `# Entorno publicado. GENERADO por deploy/preparar-env.mjs: NO se versiona ni se comparte.\n${lineas.join('\n').replace(/^# Copiar a \.env\. Valores solo para desarrollo\.\n/, '')}\n`;
}

const esPrincipal = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (esPrincipal) {
  const dominio = process.argv[2];
  if (!dominio || !/^(:80|[a-z0-9.-]+\.[a-z]{2,})$/i.test(dominio)) {
    console.error('Uso: node deploy/preparar-env.mjs <dominio>   (por ejemplo viajes.midominio.com, o :80 detrás de un túnel)');
    process.exit(1);
  }
  if (existsSync(RUTA_PRODUCCION)) {
    console.log('deploy/.env.produccion ya existe: no se modificó.');
    process.exit(0);
  }
  writeFileSync(RUTA_PRODUCCION, aplicar(readFileSync(RUTA_EJEMPLO, 'utf8'), valoresProduccion(dominio)), { mode: 0o600 });
  console.log('deploy/.env.produccion creado, con secretos nuevos (no se muestran).');
}
