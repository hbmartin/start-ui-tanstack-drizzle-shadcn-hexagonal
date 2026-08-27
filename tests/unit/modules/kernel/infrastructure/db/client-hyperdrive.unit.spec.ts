import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '@/modules/kernel/infrastructure/db/client';

const mocks = vi.hoisted(() => ({
  clientConnect: vi.fn(),
  clientEnd: vi.fn(),
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

    const database = await createHyperdriveDbClient({ connectionString });

    expect(mocks.clientOptions).toEqual([{ connectionString }]);
    expect(mocks.clientConnect).toHaveBeenCalledOnce();
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

      await expect(createHyperdriveDbClient(binding)).rejects.toThrow(
        /START_UI_DATABASE Hyperdrive binding/u
      );
      expect(mocks.clientOptions).toEqual([]);
    }
  );

  it('closes a client whose connection attempt fails', async () => {
    const connectionFailure = new Error('connect failed');
    mocks.clientConnect.mockRejectedValueOnce(connectionFailure);
    const { createHyperdriveDbClient } =
      await import('@/modules/kernel/infrastructure/db/client');

    await expect(createHyperdriveDbClient({ connectionString })).rejects.toBe(
      connectionFailure
    );
    expect(mocks.clientEnd).toHaveBeenCalledOnce();
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

    const first = runWithRuntimeDatabaseClient(databaseA, async () => {
      const cachedProxy = getDefaultDbClient() as Database & { marker: string };
      firstStarted();
      await firstMayFinish;
      return cachedProxy.marker;
    });
    await firstHasStarted;
    const second = runWithRuntimeDatabaseClient(databaseB, async () => {
      const cachedProxy = getDefaultDbClient() as Database & { marker: string };
      await Promise.resolve();
      return cachedProxy.marker;
    });
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([
      'database-a',
      'database-b',
    ]);
  });
});
