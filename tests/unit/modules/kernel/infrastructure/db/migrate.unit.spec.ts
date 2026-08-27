import { makeTestDatabaseUrl } from '@tests/server/test-database-url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigurationError } from '@/modules/kernel/domain/errors/configuration-error';
import type {
  MigrationDatabase,
  MigrationDatabaseClient,
} from '@/modules/kernel/infrastructure/db/migrate';

const mocks = vi.hoisted(() => ({
  migrationClient: {
    connect: vi.fn(),
    end: vi.fn(),
    query: vi.fn(),
  },
  neonClientConfig: undefined as string | undefined,
  nodePgClientConfig: undefined as
    | { connectionString: string; ssl: boolean | object }
    | undefined,
  drizzleNeonWebsocket: vi.fn(),
  drizzleNodePg: vi.fn(),
  migrateNeonWebsocket: vi.fn(),
  migrateNodePg: vi.fn(),
  webSocketConstructor: undefined as unknown,
}));

vi.mock('pg', () => ({
  Client: class {
    constructor(config: { connectionString: string; ssl: boolean | object }) {
      mocks.nodePgClientConfig = config;
      return mocks.migrationClient;
    }
  },
}));

vi.mock('@neondatabase/serverless', () => ({
  Client: class {
    constructor(config: string) {
      mocks.neonClientConfig = config;
      return mocks.migrationClient;
    }
  },
  neonConfig: {
    set webSocketConstructor(value: unknown) {
      mocks.webSocketConstructor = value;
    },
  },
}));

vi.mock('drizzle-orm/neon-serverless', () => ({
  drizzle: mocks.drizzleNeonWebsocket,
}));

vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: mocks.drizzleNodePg,
}));

vi.mock('drizzle-orm/neon-serverless/migrator', () => ({
  migrate: mocks.migrateNeonWebsocket,
}));

vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: mocks.migrateNodePg,
}));

vi.mock('@/modules/kernel/infrastructure/config/application', () => ({
  getApplicationIdentity: () => ({ name: 'Acme Test', slug: 'acme-test' }),
}));

const dbWithDriver = (driver: MigrationDatabase['$migrationDriver']) =>
  ({
    $migrationDriver: driver,
    $client: mocks.migrationClient as unknown as MigrationDatabaseClient,
  }) as MigrationDatabase;

describe('migrateDatabase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.migrationClient.query.mockResolvedValue({ rows: [] });
    mocks.migrationClient.query.mockResolvedValueOnce({
      rows: [{ acquired: true }],
    });
  });

  it('acquires and releases the migration advisory lock', async () => {
    const { migrateDatabase } =
      await import('@/modules/kernel/infrastructure/db/migrate');
    const db = dbWithDriver('node-pg');

    await migrateDatabase(db);

    expect(mocks.migrationClient.query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired',
      ['acme-test', 'drizzle-migrations']
    );
    expect(mocks.migrateNodePg).toHaveBeenCalledWith(db, {
      migrationsFolder: 'drizzle/migrations',
    });
    expect(mocks.migrationClient.query).toHaveBeenLastCalledWith(
      'SELECT pg_advisory_unlock(hashtext($1), hashtext($2))',
      ['acme-test', 'drizzle-migrations']
    );
  });

  it('uses the Neon WebSocket migrator for Neon migration clients', async () => {
    const { migrateDatabase } =
      await import('@/modules/kernel/infrastructure/db/migrate');
    const db = dbWithDriver('neon-websocket');

    await migrateDatabase(db);

    expect(mocks.migrateNeonWebsocket).toHaveBeenCalledWith(db, {
      migrationsFolder: 'drizzle/migrations',
    });
    expect(mocks.migrateNodePg).not.toHaveBeenCalled();
  });

  it('does not run migrations when the migration lock is held', async () => {
    mocks.migrationClient.query.mockReset();
    mocks.migrationClient.query.mockResolvedValueOnce({
      rows: [{ acquired: false }],
    });
    const { migrateDatabase } =
      await import('@/modules/kernel/infrastructure/db/migrate');

    await expect(migrateDatabase(dbWithDriver('node-pg'))).rejects.toThrow(
      ConfigurationError
    );

    expect(mocks.migrateNodePg).not.toHaveBeenCalled();
    expect(mocks.migrateNeonWebsocket).not.toHaveBeenCalled();
  });

  it('releases the migration lock when migration fails', async () => {
    const error = new Error('migration failed');
    mocks.migrateNodePg.mockRejectedValueOnce(error);
    const { migrateDatabase } =
      await import('@/modules/kernel/infrastructure/db/migrate');

    await expect(migrateDatabase(dbWithDriver('node-pg'))).rejects.toThrow(
      'migration failed'
    );

    expect(mocks.migrationClient.query).toHaveBeenLastCalledWith(
      'SELECT pg_advisory_unlock(hashtext($1), hashtext($2))',
      ['acme-test', 'drizzle-migrations']
    );
  });
});

describe('createMigrationDbClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nodePgClientConfig = undefined;
    mocks.migrationClient.connect.mockResolvedValue(undefined);
    mocks.migrationClient.end.mockResolvedValue(undefined);
    mocks.drizzleNodePg.mockImplementation((client) => ({ $client: client }));
    mocks.drizzleNeonWebsocket.mockImplementation(({ client }) => ({
      $client: client,
    }));
  });

  it('creates and connects a node-postgres migration client', async () => {
    const databaseUrl = makeTestDatabaseUrl();
    const { createMigrationDbClient } =
      await import('@/modules/kernel/infrastructure/db/migrate');

    const db = await createMigrationDbClient({
      databaseUrl,
      driver: 'node-pg',
      tlsPolicy: 'verify',
    });

    expect(mocks.nodePgClientConfig).toEqual({
      connectionString: databaseUrl,
      ssl: true,
    });
    expect(mocks.drizzleNodePg).toHaveBeenCalledWith(mocks.migrationClient, {
      schema: expect.any(Object),
      casing: 'camelCase',
    });
    expect(mocks.migrationClient.connect).toHaveBeenCalledOnce();
    expect(db.$migrationDriver).toBe('node-pg');
  });

  it('creates and connects a Neon WebSocket migration client', async () => {
    const databaseUrl = makeTestDatabaseUrl();
    const { createMigrationDbClient } =
      await import('@/modules/kernel/infrastructure/db/migrate');

    const db = await createMigrationDbClient({
      databaseUrl,
      driver: 'neon-websocket',
      tlsPolicy: 'verify',
    });

    expect(mocks.neonClientConfig).toBe(databaseUrl);
    expect(mocks.webSocketConstructor).toBeDefined();
    expect(mocks.drizzleNeonWebsocket).toHaveBeenCalledWith({
      client: mocks.migrationClient,
      ws: expect.anything(),
      schema: expect.any(Object),
      casing: 'camelCase',
    });
    expect(mocks.migrationClient.connect).toHaveBeenCalledOnce();
    expect(db.$migrationDriver).toBe('neon-websocket');
  });

  it('rejects migration URL overrides before constructing a client', async () => {
    const databaseUrl = `${makeTestDatabaseUrl()}?sslmode=disable`;
    const { createMigrationDbClient } =
      await import('@/modules/kernel/infrastructure/db/migrate');

    await expect(
      createMigrationDbClient({
        databaseUrl,
        driver: 'node-pg',
        tlsPolicy: 'verify',
      })
    ).rejects.toThrow(
      'migration database client URL must not configure endpoint or TLS parameters in the URL (sslmode); remove those parameters, keep the endpoint in the URL authority, and configure TLS with the caller-provided policy.'
    );
    expect(mocks.nodePgClientConfig).toBeUndefined();
  });

  it('uses natural policy remediation for programmatic migration config', async () => {
    const { createMigrationDbClient } =
      await import('@/modules/kernel/infrastructure/db/migrate');

    await expect(
      createMigrationDbClient({
        databaseUrl: makeTestDatabaseUrl({ host: 'db.example.com' }),
        driver: 'node-pg',
        tlsPolicy: 'off',
      })
    ).rejects.toThrow(
      "migration database client URL must not use TLS policy 'off' for a remote database; use a 'verify' policy or use a loopback endpoint."
    );
    expect(mocks.nodePgClientConfig).toBeUndefined();
  });

  it('rejects malformed migration URLs before constructing a client', async () => {
    const { createMigrationDbClient } =
      await import('@/modules/kernel/infrastructure/db/migrate');

    await expect(
      createMigrationDbClient({
        databaseUrl: 'app',
        driver: 'node-pg',
        tlsPolicy: 'verify',
      })
    ).rejects.toThrow(ConfigurationError);
    expect(mocks.nodePgClientConfig).toBeUndefined();
  });
});
