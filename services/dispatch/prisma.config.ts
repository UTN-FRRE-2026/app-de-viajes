import { defineConfig } from 'prisma/config';

// La URL se lee de DATABASE_URL (el CLI no carga .env solo desde Prisma 7).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? 'postgresql://dispatch_svc:dispatch_dev@localhost:5434/dispatch' },
});
