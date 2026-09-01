/* eslint-disable no-process-env */
import { defineConfig } from 'drizzle-kit';

import { getMigrationDatabaseConfig } from './src/modules/kernel/infrastructure/config/database';
import { nodePostgresConnectionStringForPolicy } from './src/modules/kernel/infrastructure/db/node-postgres-tls';

const database = getMigrationDatabaseConfig();

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/modules/kernel/infrastructure/db/schema/**/*.ts',
    './src/modules/*/infrastructure/drizzle/schema.ts',
  ],
  out: './drizzle/migrations',
  dbCredentials: {
    url: nodePostgresConnectionStringForPolicy(
      database.databaseUrl,
      database.tlsPolicy
    ),
  },
  casing: 'camelCase',
});
