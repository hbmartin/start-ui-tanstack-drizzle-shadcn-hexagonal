import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {
    databaseUrl: 'postgres://user@db.example.com:5432/app',
    driver: 'node-pg' as const,
    tlsPolicy: 'verify' as 'encrypt' | 'verify',
  },
  poolConfig: undefined as
    | {
        connectionString: string;
        max: number;
        ssl: boolean | object;
      }
    | undefined,
  poolEnd: vi.fn(async () => undefined),
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@/modules/kernel/infrastructure/config/database', () => ({
  getDatabaseConfig: () => mocks.config,
  isLikelyTransactionPooledDatabaseUrl: () => false,
}));

vi.mock('pg', () => ({
  Pool: class {
    constructor(config: {
      connectionString: string;
      max: number;
      ssl: boolean | object;
    }) {
      mocks.poolConfig = config;
    }

    connect = vi.fn(async () => ({
      query: mocks.query,
      release: mocks.release,
    }));

    end = mocks.poolEnd;
  },
}));

describe('PostgreSQL advisory lock TLS policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.poolConfig = undefined;
    mocks.query.mockResolvedValueOnce({ rows: [] });
    mocks.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });
  });

  it.each([
    ['encrypt', { rejectUnauthorized: false }],
    ['verify', true],
  ] as const)(
    'passes the %s policy to its dedicated pool',
    async (policy, ssl) => {
      mocks.config.tlsPolicy = policy;
      const { tryAcquirePostgresAdvisoryLock } =
        await import('@/modules/kernel/infrastructure/db/postgres-advisory-lock');

      await expect(
        tryAcquirePostgresAdvisoryLock({ key: 'job', namespace: 'app' })
      ).resolves.toBeUndefined();
      expect(mocks.poolConfig).toEqual({
        connectionString: mocks.config.databaseUrl,
        max: 1,
        ssl,
      });
    }
  );
});
