import {
  mockDb,
  mockGetSession,
  mockLogger,
  mockUserHasPermission,
  resetMockDb,
  setupAuthenticatedUser,
} from '@tests/server/test-utils';
import { beforeEach, vi } from 'vitest';

import { ACTIVE_CAPABILITY_PRESET } from '@/modules/kernel';

vi.mock('@/modules/auth/infrastructure/better-auth/auth', () => {
  const defaultAuth = {
    api: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      userHasPermission: (...args: unknown[]) => mockUserHasPermission(...args),
    },
  };

  return {
    auth: defaultAuth,
    createAuth: () => ({
      api: {
        getSession: (...args: unknown[]) => mockGetSession(...args),
        userHasPermission: (...args: unknown[]) =>
          mockUserHasPermission(...args),
      },
    }),
    getDefaultAuth: () => defaultAuth,
  };
});

vi.mock('@tanstack/react-start/server', () => ({
  getCookie: vi.fn(() => undefined),
  getRequestHeaders: () => new Headers(),
  setCookie: vi.fn(),
  setResponseHeader: vi.fn(),
}));

vi.mock('@/platform/env/client', () => {
  const envClient = {
    VITE_BASE_URL: 'http://localhost:3000',
    VITE_AUTH_SIGNUP_ENABLED: true,
    VITE_S3_BUCKET_PUBLIC_URL: 'http://127.0.0.1:9000/default',
    VITE_SENTRY_DSN: undefined,
    VITE_SENTRY_ENVIRONMENT: undefined,
    VITE_SENTRY_TRACES_SAMPLE_RATE: 0,
    VITE_VISUAL_TEST: false,
  };
  return { envClient, getEnvClient: () => envClient };
});

vi.mock('@/modules/kernel/infrastructure/logger/telemetry', () => ({
  createTelemetryLogger: () => mockLogger,
}));

vi.mock('@/modules/kernel/infrastructure/db/client', () => {
  const defaultTransactionRunner = {
    run: (work: (tx: typeof mockDb) => Promise<unknown>) => work(mockDb),
  };

  return {
    db: mockDb,
    createDbClient: () => mockDb,
    getDefaultDbClient: () => mockDb,
    createTransactionRunner: (database: typeof mockDb = mockDb) => ({
      run: (work: (tx: typeof mockDb) => Promise<unknown>) => work(database),
    }),
    getDefaultTransactionRunner: () => defaultTransactionRunner,
    transactionRunner: defaultTransactionRunner,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_SECRET', 'unit-test-auth-secret-12345678901234567890');
  vi.stubEnv(
    'AUTH_RATE_LIMIT_HMAC_SECRET',
    'unit-test-rate-secret-12345678901234567890'
  );
  vi.stubEnv('APP_NAME', 'Start UI Test');
  vi.stubEnv('APP_SLUG', 'start-ui-test');
  vi.stubEnv('CAPABILITY_PRESET', ACTIVE_CAPABILITY_PRESET);
  resetMockDb();
  setupAuthenticatedUser();
});
