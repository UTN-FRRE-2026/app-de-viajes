// Carga los usuarios de prueba (uno por rol). Solo para desarrollo: los privilegiados no se
// pueden crear por el registro público.
import { CONTRASENA_MIN } from '@viajes/contracts';
import { crearPrisma } from '../src/infra/db/cliente.js';
import { sembrarUsuarios } from '../src/infra/db/semilla.js';
import { HasherArgon2 } from '../src/infra/externos/hasher-argon2.js';

if (process.env.NODE_ENV === 'production') {
  console.error('El seed no se puede correr con NODE_ENV=production.');
  process.exit(1);
}

const url = process.env.IDENTITY_DATABASE_URL;
const contrasena = process.env.IDENTITY_SEED_CONTRASENA;
if (!url || !contrasena || contrasena.length < CONTRASENA_MIN) {
  console.error(`Faltan IDENTITY_DATABASE_URL o IDENTITY_SEED_CONTRASENA (mínimo ${CONTRASENA_MIN} caracteres).`);
  process.exit(1);
}

const prisma = crearPrisma(url, 2);
try {
  const cantidad = await sembrarUsuarios(prisma, new HasherArgon2(), contrasena);
  console.log(`Seed listo: ${cantidad} usuarios.`);
} finally {
  await prisma.$disconnect();
}
