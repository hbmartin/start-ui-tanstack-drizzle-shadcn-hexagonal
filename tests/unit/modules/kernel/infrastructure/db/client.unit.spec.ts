import { makeTestDatabaseUrl } from '@tests/server/test-database-url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ConfigurationError } from '@/modules/kernel/domain/errors/configuration-error';
import type {
  Database,
  DbTransaction,
} from '@/modules/kernel/infrastructure/db/client';
import { telemetryProxy } from '@/platform/telemetry';

vi.unmock('@/modules/kernel/infrastructure/db/client');

const databaseUrl = makeTestDatabaseUrl({ protocol: 'postgresql' });

describe('database client', () => {
  let createDbClient: typeof import('@/modules/kernel/infrastructure/db/client').createDbClient;
  let createTransactionRunner: typeof import('@/modules/kernel/infrastructure/db/client').createTransactionRunner;
  let getDefaultDbClient: typeof import('@/modules/kernel/infrastructure/db/client').getDefaultDbClient;
  const clients: Array<
    ReturnType<
      typeof import('@/modules/kernel/infrastructure/db/client').createDbClient
    >
  > = [];

  beforeAll(async () => {
    ({ createDbClient, createTransactionRunner, getDefaultDbClient } =
      await import('@/modules/kernel/infrastructure/db/client'));
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.$close()));
    clients.length = 0;
    vi.unstubAllEnvs();
  });

  it('defaults explicit URLs to the node-pg driver', () => {
    const db = createDbClient({ url: databaseUrl });
    clients.push(db);

    expect(db.$driver).toBe('node-pg');
    expect(db.$transactionCapable).toBe(true);
  });

  it('passes the explicit verification policy to node-postgres', () => {
    const db = createDbClient({
      tlsPolicy: 'verify',
      url: databaseUrl,
    });
    clients.push(db);

    const pool = (
      db as unknown as {
        $client: { options: { ssl: boolean | object } };
      }
    ).$client;
    expect(pool.options.ssl).toBe(true);
  });

  it('contains idle pool errors and reports them through the caller', () => {
    const onError = vi.fn();
    const db = createDbClient({ onError, url: databaseUrl });
    clients.push(db);
    const pool = db.$client as unknown as {
      emit(eventName: string, error: Error): boolean;
    };
    const poolFailure = new Error('idle connection failed');

    expect(() => pool.emit('error', poolFailure)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(poolFailure);
  });

  it('captures idle pool errors through actionable telemetry by default', () => {
    const captureException = vi
      .spyOn(telemetryProxy, 'captureException')
      .mockImplementation(() => undefined);
    const db = createDbClient({ url: databaseUrl });
    clients.push(db);
    const pool = db.$client as unknown as {
      emit(eventName: string, error: Error): boolean;
    };
    const poolFailure = new Error('idle connection failed');

    pool.emit('error', poolFailure);

    expect(captureException).toHaveBeenCalledWith(poolFailure, {
      level: 'error',
      tags: { event: 'database.node_postgres.pool' },
    });
    captureException.mockRestore();
  });

  it('defaults explicit production URLs to verification', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const db = createDbClient({
      url: 'postgresql://user@db.example.com:5432/app',
    });
    clients.push(db);

    const pool = (
      db as unknown as {
        $client: { options: { ssl: boolean | object } };
      }
    ).$client;
    expect(pool.options.ssl).toBe(true);
  });

  it('rejects connection-string overrides before node-postgres parses them', () => {
    expect(() =>
      createDbClient({
        tlsPolicy: 'verify',
        url: `${databaseUrl}?host=attacker.example.com&sslmode=disable`,
      })
    ).toThrow(ConfigurationError);
  });

  it('rejects malformed explicit URLs before node-postgres applies ambient defaults', () => {
    expect(() => createDbClient({ url: 'app' })).toThrow(ConfigurationError);
  });

  it('revalidates driver overrides against the resolved env policy', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', 'postgresql://user@db.example.com:5432/app');
    vi.stubEnv('DATABASE_DRIVER', 'node-pg');
    vi.stubEnv('DATABASE_TLS_POLICY', 'encrypt');

    expect(() => createDbClient({ driver: 'neon-http' })).toThrow(
      ConfigurationError
    );
  });

  it('can create a Neon HTTP client without transaction capability', () => {
    const db = createDbClient({ driver: 'neon-http', url: databaseUrl });
    clients.push(db);

    expect(db.$driver).toBe('neon-http');
    expect(db.$transactionCapable).toBe(false);
    expect(() => createTransactionRunner(db)).not.toThrow();
  });

  it('can create a Neon WebSocket client with transaction capability', () => {
    const db = createDbClient({ driver: 'neon-websocket', url: databaseUrl });
    clients.push(db);

    expect(db.$driver).toBe('neon-websocket');
    expect(db.$transactionCapable).toBe(true);
  });

  it('defers missing transaction support errors until runner execution', async () => {
    const db = {
      $driver: 'neon-http',
      $transactionCapable: false,
    } as unknown as Database;
    const runner = createTransactionRunner(db);

    await expect(runner.run(async () => 'unreachable')).rejects.toThrow(
      ConfigurationError
    );
  });

  it('delegates transaction runner work to database transaction metadata', async () => {
    const tx = {} as DbTransaction;
    const runInTransaction = vi.fn(
      async <T>(work: (transaction: DbTransaction) => Promise<T>) => work(tx)
    );
    const db = {
      $driver: 'neon-http',
      $transactionCapable: false,
      $runInTransaction: runInTransaction,
    } as unknown as Database;
    const work = vi.fn(async (transaction: DbTransaction) => ({
      transaction,
    }));

    const transactionOptions = { isolationLevel: 'serializable' } as const;

    await expect(
      createTransactionRunner(db).run(work, transactionOptions)
    ).resolves.toEqual({
      transaction: tx,
    });
    expect(runInTransaction).toHaveBeenCalledWith(work, transactionOptions);
    expect(work).toHaveBeenCalledWith(tx);
  });

  it('keeps the process database fallback when no runtime owner is installed', () => {
    vi.stubEnv('DATABASE_DRIVER', 'node-pg');
    vi.stubEnv('DATABASE_TLS_POLICY', 'off');
    vi.stubEnv('DATABASE_URL', databaseUrl);

    const defaultClient = getDefaultDbClient();
    clients.push(defaultClient);

    expect(defaultClient.$adapter).toBe('postgres-node');
    expect(defaultClient.$driver).toBe('node-pg');
  });
});
