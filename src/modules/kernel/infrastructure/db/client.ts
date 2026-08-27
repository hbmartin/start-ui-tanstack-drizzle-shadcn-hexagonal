import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import { drizzle as drizzleNeonWebsocket } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { createRequire } from 'node:module';
import { Client, Pool } from 'pg';

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
import {
  assertDatabaseUrlTls,
  findForbiddenDatabaseUrlParameters,
} from '@/modules/kernel/infrastructure/config/url-security';

import * as schema from './schema';
import {
  attachDatabasePoolErrorHandlers,
  createDatabaseClientErrorHandler,
  type DatabaseClientErrorHandler,
} from './client-error-handler';
import { nodePostgresSslForPolicy } from './node-postgres-tls';
import {
  getRuntimeDatabaseClient,
  isRuntimeDatabaseClientRequired,
} from './runtime-database-scope';
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
    adapter?: Database['$adapter'];
    driver: DatabaseDriver;
    transactionCapable: boolean;
    runInTransaction?: RunInTransaction;
    close: () => Promise<void>;
  }
): Database {
  return Object.assign(db, {
    $adapter: metadata.adapter,
    $driver: metadata.driver,
    $transactionCapable: metadata.transactionCapable,
    $runInTransaction: metadata.runInTransaction,
    $close: metadata.close,
  }) as unknown as Database;
}

function createNeonWebsocketDb(
  url: string,
  onError?: DatabaseClientErrorHandler
): Database {
  const WebSocket = require('ws') as unknown;
  const database = drizzleNeonWebsocket({
    connection: url,
    ws: WebSocket,
    schema,
    casing: 'camelCase',
  });
  attachDatabasePoolErrorHandlers(
    database.$client,
    'database.neon_websocket.client',
    onError
  );

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
  onError?: DatabaseClientErrorHandler;
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
      transactionDb ??= createNeonWebsocketDb(url, options?.onError);
      return transactionDb;
    };

    return withDatabaseMetadata(database, {
      adapter: 'postgres-fetch',
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
    return createNeonWebsocketDb(url, options?.onError);
  }

  const pool = new Pool({
    connectionString: url,
    ssl: nodePostgresSslForPolicy(tlsPolicy),
  });
  attachDatabasePoolErrorHandlers(
    pool,
    'database.node_postgres.client',
    options?.onError
  );
  const database = drizzleNodePg(pool, { schema, casing: 'camelCase' });

  return withDatabaseMetadata(database, {
    adapter: 'postgres-node',
    driver,
    transactionCapable: true,
    runInTransaction: (work, options) =>
      database.transaction((tx) => work(tx), options),
    close: () => pool.end(),
  });
}

export type HyperdriveBinding = Readonly<{
  connectionString: string;
}>;

const hyperdriveBindingError = (qualifier = '') =>
  new ConfigurationError(
    `The START_UI_DATABASE Hyperdrive binding must provide ${qualifier}PostgreSQL connection string.`
  );

const readHyperdriveConnectionString = (binding: unknown): string => {
  if (typeof binding !== 'object' || binding === null) {
    throw new ConfigurationError(
      'The Cloudflare runtime requires a START_UI_DATABASE Hyperdrive binding.'
    );
  }

  const { connectionString } = binding as { connectionString?: unknown };
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw hyperdriveBindingError('a ');
  }

  return connectionString;
};

const validateHyperdriveConnectionString = (connectionString: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw hyperdriveBindingError('a valid ');
  }

  const isPostgreSql =
    parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:';
  if (!isPostgreSql || parsed.hostname.length === 0) {
    throw hyperdriveBindingError('a valid ');
  }
  if (findForbiddenDatabaseUrlParameters(parsed).length > 0) {
    throw hyperdriveBindingError('a valid ');
  }
};

const parseHyperdriveBinding = (binding: unknown): HyperdriveBinding => {
  const connectionString = readHyperdriveConnectionString(binding);
  validateHyperdriveConnectionString(connectionString);
  return { connectionString };
};

/**
 * Creates the request-owned node-postgres client recommended by Hyperdrive.
 * Hyperdrive owns origin TLS and pooling; its generated URL must not be folded
 * into the process-owned DATABASE_URL/TLS configuration path.
 */
export async function createHyperdriveDbClient(
  binding: unknown,
  options: { onError?: DatabaseClientErrorHandler } = {}
): Promise<Database> {
  const { connectionString } = parseHyperdriveBinding(binding);
  const client = new Client({ connectionString });
  client.on(
    'error',
    createDatabaseClientErrorHandler(
      'database.cloudflare.hyperdrive.client',
      options.onError
    )
  );

  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }

  const database = drizzleNodePg(client, { schema, casing: 'camelCase' });
  let closed = false;
  let closing: Promise<void> | undefined;

  return withDatabaseMetadata(database, {
    adapter: 'hyperdrive',
    driver: 'node-pg',
    transactionCapable: true,
    runInTransaction: (work, options) =>
      database.transaction((tx) => work(tx), options),
    close: () => {
      if (closed) return Promise.resolve();
      closing ??= client
        .end()
        .then(() => {
          closed = true;
          return undefined;
        })
        .finally(() => {
          closing = undefined;
        });
      return closing;
    },
  });
}

export type { Database, DbLike, DbTransaction };

const globalForDb = globalThis as unknown as {
  db: Database | undefined;
};

let defaultDb = globalForDb.db;

const getProcessDefaultDbClient = (): Database => {
  if (!defaultDb) {
    defaultDb = createDbClient();
    if (isDevRuntimeEnvironment()) globalForDb.db = defaultDb;
  }
  return defaultDb;
};

const createDatabaseProxy = (resolveDatabase: () => Database): Database =>
  new Proxy({} as Database, {
    get(_target, prop) {
      const database = resolveDatabase();
      const value = Reflect.get(database, prop, database);
      return typeof value === 'function' ? value.bind(database) : value;
    },
    getOwnPropertyDescriptor(_target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        resolveDatabase(),
        prop
      );
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(resolveDatabase());
    },
    has(_target, prop) {
      return Reflect.has(resolveDatabase(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(resolveDatabase());
    },
  });

const resolveRuntimeOrProcessDatabase = (): Database => {
  const runtimeDatabase = getRuntimeDatabaseClient();
  if (runtimeDatabase) return runtimeDatabase;
  if (isRuntimeDatabaseClientRequired()) {
    throw new ConfigurationError(
      'The request-scoped runtime database is unavailable outside its owning request.'
    );
  }
  return getProcessDefaultDbClient();
};

const runtimeOrProcessDatabase = createDatabaseProxy(
  resolveRuntimeOrProcessDatabase
);

export function getDefaultDbClient(): Database {
  return runtimeOrProcessDatabase;
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

export const db = runtimeOrProcessDatabase;

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
