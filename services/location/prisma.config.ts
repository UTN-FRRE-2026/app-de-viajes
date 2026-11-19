import { defineConfig } from 'prisma/config';

// LOCATION_DATABASE_URL y no DATABASE_URL: el .env raíz es compartido y esa variable apunta a dispatch.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.LOCATION_DATABASE_URL ?? 'postgresql://location_svc:location_dev@localhost:5434/location',
  },
});
