import { defineConfig } from 'prisma/config';

// IDENTITY_DATABASE_URL y no DATABASE_URL: el .env raíz es compartido y esa variable apunta a dispatch.
// Si identity la leyera, un `migrate deploy` escribiría en la base de otro servicio.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.IDENTITY_DATABASE_URL ?? 'postgresql://identity_svc:identity_dev@localhost:5434/identity',
  },
});
