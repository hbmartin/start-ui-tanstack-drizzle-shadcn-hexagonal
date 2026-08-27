import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import { drizzle as drizzleNeonWebsocket } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { createRequire } from 'node:module';
import { Pool } from 'pg';

import type { TransactionRunner } from '@/modules/kernel/application/ports/transaction-runner';
import { ConfigurationError } from '@/modules/kernel/domain/errors/configuration-error';
import {
  type DatabaseDriver,
  getDatabaseConfig,
} from '@/modules/kernel/infrastructure/config/database';
import {
  resolveDatabaseTlsPolicy,
  type DatabaseTlsPolicy,
} from '@/modules/kernel/infrastructure/config/database-tls';
import { isDevRuntimeEnvironment } from '@/modules/kernel/infrastructure/config/env-schema';
import { assertDatabaseUrlTls } from '@/modules/kernel/infrastructure/config/url-security';

import * as schema from './schema';
import { nodePostgresSslForPolicy } from './node-postgres-tls';
import {
  type Database,
  type DbLike,
  type DbTransaction,
  type RunInTransaction,
} from './types';

const require = createRequire(import.meta.url);

function withDatabaseMetadata<TDb extends object>(
  db: TDb,
  metadata: {
    driver: DatabaseDriver;
    transactionCapable: boolean;
    runInTransaction?: RunInTransaction;
    close: () => Promise<void>;
  }
): Database {
  return Object.assign(db, {
    $driver: metadata.driver,
    $transactionCapable: metadata.transactionCapable,
    $runInTransaction: metadata.runInTransaction,
    $close: metadata.close,
  }) as unknown as Database;
}

function createNeonWebsocketDb(url: string): Database {
  const WebSocket = require('ws') as unknown;
  const database = drizzleNeonWebsocket({
    connection: url,
    ws: WebSocket,
    schema,
    casing: 'camelCase',
  });

  return withDatabaseMetadata(database, {
    driver: 'neon-websocket',
    transactionCapable: true,
    runInTransaction: (work, options) =>
      database.transaction((tx) => work(tx), options),
    close: () => database.$client.end(),
  });
}

export function createDbClient(options?: {
  driver?: DatabaseDriver;
  tlsPolicy?: DatabaseTlsPolicy;
  url?: string;
}): Database {
  const config = options?.url === undefined ? getDatabaseConfig() : undefined;
  const driver = options?.driver ?? config?.driver ?? 'node-pg';
  const url = options?.url ?? config?.databaseUrl;

  if (!url) {
    throw new ConfigurationError(
      'DATABASE_URL is required to create a database client.'
    );
  }

  const tlsPolicy = resolveDatabaseTlsPolicy({
    configuredPolicy: options?.tlsPolicy ?? config?.tlsPolicy,
    url,
  });

  assertDatabaseUrlTls({
    driver,
    name: 'database client URL',
    policy: tlsPolicy,
    url,
  });

  if (driver === 'neon-http') {
    const database = drizzleNeonHttp(url, { schema, casing: 'camelCase' });
    let transactionDb: Database | undefined;

    const getTransactionDb = () => {
      transactionDb ??= createNeonWebsocketDb(url);
      return transactionDb;
    };

    return withDatabaseMetadata(database, {
      driver,
      transactionCapable: false,
      runInTransaction: (work, options) => {
        const runInTransaction = getTransactionDb().$runInTransaction;
        if (!runInTransaction) {
          throw new ConfigurationError(
            'Neon WebSocket transaction client did not expose a transaction runner.'
          );
        }

        return runInTransaction(work, options);
      },
      close: async () => {
        await transactionDb?.$close();
        transactionDb = undefined;
      },
    });
  }

  if (driver === 'neon-websocket') {
    return createNeonWebsocketDb(url);
  }

  const pool = new Pool({
    connectionString: url,
    ssl: nodePostgresSslForPolicy(tlsPolicy),
  });
  const database = drizzleNodePg(pool, { schema, casing: 'camelCase' });

  return withDatabaseMetadata(database, {
    driver,
    transactionCapable: true,
    runInTransaction: (work, options) =>
      database.transaction((tx) => work(tx), options),
    close: () => pool.end(),
  });
}

export type { Database, DbLike, DbTransaction };

const globalForDb = globalThis as unknown as {
  db: Database | undefined;
};

let defaultDb = globalForDb.db;

export function getDefaultDbClient(): Database {
  if (!defaultDb) {
    defaultDb = createDbClient();
    if (isDevRuntimeEnvironment()) globalForDb.db = defaultDb;
  }
  return defaultDb;
}

export { schema };

export function createTransactionRunner(
  database: Database
): TransactionRunner<DbTransaction> {
  return {
    async run(work, options) {
      if (!database.$runInTransaction) {
        throw new ConfigurationError(
          `Database driver ${database.$driver} does not support interactive transactions.`
        );
      }

      return database.$runInTransaction(work, options);
    },
  };
}

let defaultTransactionRunner: TransactionRunner<DbTransaction> | undefined;

export function getDefaultTransactionRunner() {
  if (!defaultTransactionRunner) {
    defaultTransactionRunner = createTransactionRunner(getDefaultDbClient());
  }
  return defaultTransactionRunner;
}

export const db = new Proxy({} as Database, {
  get(_target, prop) {
    const database = getDefaultDbClient();
    const value = Reflect.get(database, prop, database);
    return typeof value === 'function' ? value.bind(database) : value;
  },
});

export const transactionRunner = new Proxy(
  {} as TransactionRunner<DbTransaction>,
  {
    get(_target, prop) {
      const runner = getDefaultTransactionRunner();
      const value = Reflect.get(runner, prop, runner);
      return typeof value === 'function' ? value.bind(runner) : value;
    },
  }
);
