import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ init: vi.fn() }));

vi.mock('@sentry/node', () => sentry);

const originalSentryDsn = process.env.SENTRY_DSN;
const originalPublicSentryDsn = process.env.VITE_SENTRY_DSN;
const originalSentryEnvironment = process.env.SENTRY_ENVIRONMENT;
const originalSentryRelease = process.env.SENTRY_RELEASE;

describe('server instrumentation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    process.env.VITE_SENTRY_DSN = 'https://browser@example.com/2';
    process.env.SENTRY_ENVIRONMENT = 'tests';
    process.env.SENTRY_RELEASE = 'v5-test';
  });

  afterEach(() => {
    if (originalSentryDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalSentryDsn;
    if (originalPublicSentryDsn === undefined) {
      delete process.env.VITE_SENTRY_DSN;
    } else {
      process.env.VITE_SENTRY_DSN = originalPublicSentryDsn;
    }
    if (originalSentryEnvironment === undefined) {
      delete process.env.SENTRY_ENVIRONMENT;
    } else {
      process.env.SENTRY_ENVIRONMENT = originalSentryEnvironment;
    }
    if (originalSentryRelease === undefined) delete process.env.SENTRY_RELEASE;
    else process.env.SENTRY_RELEASE = originalSentryRelease;
  });

  it('initializes exception-only Sentry without installing OTel or loader hooks', async () => {
    await import('../../instrument.server.mjs');

    expect(sentry.init).toHaveBeenCalledOnce();
    expect(sentry.init).toHaveBeenCalledWith({
      beforeSend: expect.any(Function),
      dsn: 'https://public@example.com/1',
      enableLogs: false,
      environment: 'tests',
      registerEsmLoaderHooks: false,
      release: 'v5-test',
      sendDefaultPii: false,
      skipOpenTelemetrySetup: true,
    });
  });

  it('does not abort optional server bootstrap when Sentry initialization fails', async () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    sentry.init.mockImplementationOnce(() => {
      throw new Error('Sentry unavailable');
    });

    await expect(import('../../instrument.server.mjs')).resolves.toBeDefined();

    expect(globalThis.console.error).toHaveBeenCalledWith(
      'telemetry.report_failure',
      expect.objectContaining({
        errorType: 'Error',
        source: 'sentry.instrumentation',
      })
    );
  });

  it('does not initialize server Sentry from the browser-public DSN', async () => {
    delete process.env.SENTRY_DSN;

    await import('../../instrument.server.mjs');

    expect(sentry.init).not.toHaveBeenCalled();
  });
});
