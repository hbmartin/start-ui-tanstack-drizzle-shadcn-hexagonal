import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '@/modules/kernel/infrastructure/db/client';

const mocks = vi.hoisted(() => ({
  clientConnect: vi.fn(),
  clientEnd: vi.fn(),
  clientOn: vi.fn(),
  clientOptions: [] as unknown[],
  databaseTransaction: vi.fn(),
  drizzleNodePg: vi.fn(),
}));

vi.mock('drizzle-orm/neon-http', () => ({ drizzle: vi.fn() }));
vi.mock('drizzle-orm/neon-serverless', () => ({ drizzle: vi.fn() }));
vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: mocks.drizzleNodePg,
}));
vi.mock('pg', () => ({
  Client: class {
    connect = mocks.clientConnect;
    end = mocks.clientEnd;
    on = mocks.clientOn;

    constructor(options: unknown) {
      mocks.clientOptions.push(options);
    }
  },
  Pool: class {},
}));

vi.unmock('@/modules/kernel/infrastructure/db/client');

const connectionString =
  'postgresql://hyperdrive-user:secret@hyperdrive.internal:5432/app';

describe('Cloudflare Hyperdrive database client', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.clientOptions.length = 0;
    mocks.clientConnect.mockResolvedValue(undefined);
    mocks.clientEnd.mockResolvedValue(undefined);
    mocks.databaseTransaction.mockImplementation(
      async <T>(work: (transaction: unknown) => Promise<T>) =>
        work({ type: 'hyperdrive-transaction' })
    );
    mocks.drizzleNodePg.mockReturnValue({
      marker: 'hyperdrive-database',
      transaction: mocks.databaseTransaction,
    });
  });

  it('creates one connected request client from the trusted binding', async () => {
    const { createHyperdriveDbClient, createTransactionRunner } =
      await import('@/modules/kernel/infrastructure/db/client');

    const onError = vi.fn();
    const database = await createHyperdriveDbClient(
      { connectionString },
      { onError }
    );

    expect(mocks.clientOptions).toEqual([{ connectionString }]);
    expect(mocks.clientConnect).toHaveBeenCalledOnce();
    expect(mocks.clientOn).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mocks.drizzleNodePg).toHaveBeenCalledWith(expect.anything(), {
      casing: 'camelCase',
      schema: expect.any(Object),
    });
    expect(database.$adapter).toBe('hyperdrive');
    expect(database.$driver).toBe('node-pg');
    expect(database.$transactionCapable).toBe(true);
    await expect(
      createTransactionRunner(database).run(async (transaction) => transaction)
    ).resolves.toEqual({ type: 'hyperdrive-transaction' });

    await database.$close();
    await database.$close();
    expect(mocks.clientEnd).toHaveBeenCalledOnce();
  });

  it('isolates client error diagnostics from EventEmitter failure handling', async () => {
    const { telemetryProxy } = await import('@/platform/telemetry');
    const captureException = vi
      .spyOn(telemetryProxy, 'captureException')
      .mockImplementation(() => undefined);
    const onError = vi.fn(() => {
      throw new Error('diagnostic failed');
    });
    const { createHyperdriveDbClient } =
      await import('@/modules/kernel/infrastructure/db/client');
    await createHyperdriveDbClient({ connectionString }, { onError });
    const errorListener = mocks.clientOn.mock.calls.find(
      ([eventName]) => eventName === 'error'
    )?.[1] as ((error: unknown) => void) | undefined;
    const clientFailure = new Error('socket failed');

    expect(() => errorListener?.(clientFailure)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(clientFailure);
    expect(captureException).toHaveBeenCalledWith(clientFailure, {
      level: 'error',
      tags: { event: 'database.cloudflare.hyperdrive.client' },
    });
    captureException.mockRestore();
  });

  it('captures default client errors through the actionable telemetry channel', async () => {
    const { telemetryProxy } = await import('@/platform/telemetry');
    const captureException = vi
      .spyOn(telemetryProxy, 'captureException')
      .mockImplementation(() => undefined);
    const { createHyperdriveDbClient } =
      await import('@/modules/kernel/infrastructure/db/client');
    await createHyperdriveDbClient({ connectionString });
    const errorListener = mocks.clientOn.mock.calls.find(
      ([eventName]) => eventName === 'error'
    )?.[1] as ((error: unknown) => void) | undefined;
    const clientFailure = new Error('socket failed');

    errorListener?.(clientFailure);

    expect(captureException).toHaveBeenCalledWith(clientFailure, {
      level: 'error',
      tags: { event: 'database.cloudflare.hyperdrive.client' },
    });
    captureException.mockRestore();
  });

  it.each([
    undefined,
    {},
    { connectionString: '' },
    { connectionString: 'https://database.example/app' },
    { connectionString: 'postgresql:///app' },
  ])(
    'rejects invalid binding input without opening a client',
    async (binding) => {
      const { createHyperdriveDbClient } =
        await import('@/modules/kernel/infrastructure/db/client');

      await expect(
        createHyperdriveDbClient(binding, { onError: vi.fn() })
      ).rejects.toThrow(/START_UI_DATABASE Hyperdrive binding/u);
      expect(mocks.clientOptions).toEqual([]);
    }
  );

  it.each(['host', 'HOST', 'hostaddr', 'port', 'sslmode', 'ssl_future'])(
    'rejects the %s connection-string override from a trusted binding',
    async (parameterName) => {
      const { createHyperdriveDbClient } =
        await import('@/modules/kernel/infrastructure/db/client');
      const overriddenUrl = new URL(connectionString);
      overriddenUrl.searchParams.set(parameterName, 'attacker.example');

      await expect(
        createHyperdriveDbClient(
          { connectionString: overriddenUrl.toString() },
          { onError: vi.fn() }
        )
      ).rejects.toThrow(/valid PostgreSQL connection string/u);
      expect(mocks.clientOptions).toEqual([]);
    }
  );

  it('closes a client whose connection attempt fails', async () => {
    const connectionFailure = new Error('connect failed');
    mocks.clientConnect.mockRejectedValueOnce(connectionFailure);
    const { createHyperdriveDbClient } =
      await import('@/modules/kernel/infrastructure/db/client');

    await expect(
      createHyperdriveDbClient({ connectionString }, { onError: vi.fn() })
    ).rejects.toBe(connectionFailure);
    expect(mocks.clientEnd).toHaveBeenCalledOnce();
  });

  it('deduplicates concurrent close and permits a retry after failure', async () => {
    const closeFailure = new Error('close failed');
    mocks.clientEnd
      .mockRejectedValueOnce(closeFailure)
      .mockResolvedValueOnce(undefined);
    const { createHyperdriveDbClient } =
      await import('@/modules/kernel/infrastructure/db/client');
    const database = await createHyperdriveDbClient(
      { connectionString },
      { onError: vi.fn() }
    );

    const firstClose = database.$close();
    const concurrentClose = database.$close();
    expect(firstClose).toBe(concurrentClose);
    await expect(firstClose).rejects.toBe(closeFailure);
    await expect(database.$close()).resolves.toBeUndefined();
    await expect(database.$close()).resolves.toBeUndefined();
    expect(mocks.clientEnd).toHaveBeenCalledTimes(2);
  });

  it('keeps cached default-client proxies isolated across concurrent requests', async () => {
    const { getDefaultDbClient } =
      await import('@/modules/kernel/infrastructure/db/client');
    const { runWithRuntimeDatabaseClient } =
      await import('@/modules/kernel/infrastructure/db/runtime-database-scope');
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstHasStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const databaseA = {
      marker: 'database-a',
    } as unknown as Database;
    const databaseB = {
      marker: 'database-b',
    } as unknown as Database;
    const cachedProxy = getDefaultDbClient() as Database & { marker: string };

    const first = runWithRuntimeDatabaseClient(databaseA, async () => {
      firstStarted();
      await firstMayFinish;
      return cachedProxy.marker;
    });
    await firstHasStarted;
    const second = runWithRuntimeDatabaseClient(databaseB, async () => {
      await Promise.resolve();
      return cachedProxy.marker;
    });
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([
      'database-a',
      'database-b',
    ]);
    expect(() => cachedProxy.marker).toThrow(
      /request-scoped runtime database is unavailable/u
    );
  });

  it('can require the runtime adapter before the first request scope', async () => {
    const { getDefaultDbClient } =
      await import('@/modules/kernel/infrastructure/db/client');
    const { requireRuntimeDatabaseClient } =
      await import('@/modules/kernel/infrastructure/db/runtime-database-scope');
    const cachedProxy = getDefaultDbClient();

    requireRuntimeDatabaseClient();

    expect(() => cachedProxy.$driver).toThrow(
      /request-scoped runtime database is unavailable/u
    );
  });
});
