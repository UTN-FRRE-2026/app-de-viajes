import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/generated/**', 'apps/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // El dominio no conoce frameworks ni infraestructura: si alguien los importa, `npm run lint` falla.
    files: ['services/*/src/dominio/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['express', 'ioredis', 'amqplib', 'bullmq', 'pg', 'pino', '@viajes/platform'],
          patterns: [
            { group: ['@prisma/*'], message: 'El dominio no usa Prisma: va en infra/db.' },
            { group: ['**/infra/**', '**/generated/**'], message: 'El dominio no importa adaptadores.' },
          ],
        },
      ],
    },
  },
);
