import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  eventFiltersIntegration: vi.fn(() => ({ name: 'EventFilters' })),
  captureException: vi.fn(),
  close: vi.fn(async () => true),
  init: vi.fn((_options: Record<string, unknown>) => ({})),
  linkedErrorsIntegration: vi.fn(() => ({ name: 'LinkedErrors' })),
  setNodeAsyncContextStrategy: vi.fn(),
}));

vi.mock('@sentry/node', () => sentry);

const originalSentryDsn = process.env.SENTRY_DSN;
const originalPublicSentryDsn = process.env.VITE_SENTRY_DSN;
const originalSentryEnvironment = process.env.SENTRY_ENVIRONMENT;
const originalSentryRelease = process.env.SENTRY_RELEASE;
const nodeNitroFatalOwner = Symbol.for(
  'start-ui-web.telemetry.node-nitro-fatal-owner'
);
const telemetryGlobals = globalThis as unknown as Record<symbol, unknown>;
let originalUncaughtExceptionListeners: Set<NodeJS.UncaughtExceptionListener>;
let originalUnhandledRejectionListeners: Set<NodeJS.UnhandledRejectionListener>;
const processMetaListeners = process as unknown as {
  listeners(event: 'newListener'): Array<(...args: unknown[]) => void>;
  removeListener(
    event: 'newListener',
    listener: (...args: unknown[]) => void
  ): void;
};
const originalNewListenerListeners = new Set(
  processMetaListeners.listeners('newListener')
);

type FatalCollectorMode = 'hang' | 'off' | 'respond';
type FatalFailureMode = 'reject' | 'throw';

const runFatalProcessProbe = async (
  failureMode: FatalFailureMode,
  collectorMode: FatalCollectorMode
) => {
  const instrumentationUrl = pathToFileURL(
    path.join(process.cwd(), 'instrument.server.mjs')
  ).href;
  const secret = `raw-${failureMode}-secret`;
  const script = `
    const collectorMode = ${JSON.stringify(collectorMode)};
    if (collectorMode === 'off') {
      delete process.env.SENTRY_DSN;
    } else {
      const { createServer } = await import('node:http');
      const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        process.stdout.write('ENVELOPE:' + Buffer.concat(chunks).toString('base64') + '\\n');
        if (collectorMode === 'respond') response.end('ok');
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      process.env.SENTRY_DSN = 'http://public@127.0.0.1:' + address.port + '/1';
    }
    globalThis[Symbol.for('start-ui-web.telemetry.node-nitro-fatal-owner')] = true;
    await import(${JSON.stringify(instrumentationUrl)});
    setImmediate(() => {
      const failure = new Error(${JSON.stringify(secret)});
      failure.name = 'Bearer-' + ${JSON.stringify(secret)};
      if (${JSON.stringify(failureMode)} === 'throw') throw failure;
      void Promise.reject(failure);
    });
    setTimeout(() => process.exit(2), 8_000);
  `;
  const startedAt = performance.now();
  const childResult = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('fatal process probe exceeded 10 seconds'));
    }, 10_000);
    watchdog.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve({ code, signal, stderr, stdout });
    });
  });

  return {
    ...childResult,
    durationMs: performance.now() - startedAt,
    envelopes: childResult.stdout
      .split('\n')
      .filter((line) => line.startsWith('ENVELOPE:')),
    secret,
  };
};

const decodedEnvelope = (encoded: string) =>
  Buffer.from(encoded.slice('ENVELOPE:'.length), 'base64').toString('utf8');

const removeAddedProcessListeners = <T>(
  currentListeners: T[],
  originalListeners: Set<T>,
  removeListener: (listener: T) => void
) => {
  for (const listener of currentListeners) {
    if (!originalListeners.has(listener)) removeListener(listener);
  }
};

const restoreEnvironmentVariable = (
  name: string,
  originalValue: string | undefined
) => {
  if (originalValue === undefined) delete process.env[name];
  else process.env[name] = originalValue;
};

describe('server instrumentation', () => {
  beforeEach(() => {
    originalUncaughtExceptionListeners = new Set(
      process.listeners('uncaughtException')
    );
    originalUnhandledRejectionListeners = new Set(
      process.listeners('unhandledRejection')
    );
    vi.resetModules();
    vi.clearAllMocks();
    telemetryGlobals[nodeNitroFatalOwner] = true;
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    process.env.VITE_SENTRY_DSN = 'https://browser@example.com/2';
    process.env.SENTRY_ENVIRONMENT = 'tests';
    process.env.SENTRY_RELEASE = 'v5-test';
  });

  afterEach(() => {
    removeAddedProcessListeners(
      process.listeners('uncaughtException'),
      originalUncaughtExceptionListeners,
      (listener) => process.removeListener('uncaughtException', listener)
    );
    removeAddedProcessListeners(
      process.listeners('unhandledRejection'),
      originalUnhandledRejectionListeners,
      (listener) => process.removeListener('unhandledRejection', listener)
    );
    for (const listener of processMetaListeners.listeners('newListener')) {
      if (!originalNewListenerListeners.has(listener)) {
        processMetaListeners.removeListener('newListener', listener);
      }
    }
    delete globalThis[
      Symbol.for('start-ui-web.telemetry.instrumentation-state') as never
    ];
    delete globalThis[
      Symbol.for('start-ui-web.telemetry.fatal-owner-ready') as never
    ];
    delete telemetryGlobals[nodeNitroFatalOwner];
    restoreEnvironmentVariable('SENTRY_DSN', originalSentryDsn);
    restoreEnvironmentVariable('VITE_SENTRY_DSN', originalPublicSentryDsn);
    restoreEnvironmentVariable('SENTRY_ENVIRONMENT', originalSentryEnvironment);
    restoreEnvironmentVariable('SENTRY_RELEASE', originalSentryRelease);
  });

  it('initializes exception-only Sentry without installing OTel or loader hooks', async () => {
    await import('../../instrument.server.mjs');
    const { isServerSentryInstrumentationReady } =
      await import('@/platform/telemetry/instrumentation-readiness');

    expect(sentry.init).toHaveBeenCalledOnce();
    expect(sentry.setNodeAsyncContextStrategy).toHaveBeenCalledOnce();
    expect(
      sentry.setNodeAsyncContextStrategy.mock.invocationCallOrder[0]
    ).toBeLessThan(sentry.init.mock.invocationCallOrder[0]!);
    expect(sentry.init).toHaveBeenCalledWith({
      beforeSend: expect.any(Function),
      beforeSendTransaction: expect.any(Function),
      defaultIntegrations: false,
      dsn: 'https://public@example.com/1',
      enableLogs: false,
      environment: 'tests',
      integrations: [{ name: 'EventFilters' }, { name: 'LinkedErrors' }],
      registerEsmLoaderHooks: false,
      release: 'v5-test',
      sendDefaultPii: false,
      skipOpenTelemetrySetup: true,
      tracePropagationTargets: [],
    });
    const options = sentry.init.mock.calls[0]?.[0] as {
      beforeSendTransaction: () => null;
    };
    expect(options?.beforeSendTransaction()).toBeNull();
    expect(options).not.toHaveProperty('tracesSampleRate');
    expect(options).not.toHaveProperty('tracesSampler');
    expect(isServerSentryInstrumentationReady()).toBe(true);
  });

  it('is process-global idempotent when the built artifact contains two module copies', async () => {
    await import('../../instrument.server.mjs');
    const firstUncaughtHandlers = process.listeners('uncaughtException');
    const firstRejectionHandlers = process.listeners('unhandledRejection');
    const firstMetaHandlers = processMetaListeners.listeners('newListener');

    vi.resetModules();
    await import('../../instrument.server.mjs');

    expect(process.listeners('uncaughtException')).toEqual(
      firstUncaughtHandlers
    );
    expect(process.listeners('unhandledRejection')).toEqual(
      firstRejectionHandlers
    );
    expect(processMetaListeners.listeners('newListener')).toEqual(
      firstMetaHandlers
    );
    expect(sentry.init).toHaveBeenCalledOnce();
  });

  it('does not intercept fatal listeners outside the Node Nitro owner', async () => {
    delete telemetryGlobals[nodeNitroFatalOwner];
    const uncaughtBefore = process.listeners('uncaughtException');
    const rejectionBefore = process.listeners('unhandledRejection');
    const metaBefore = processMetaListeners.listeners('newListener');

    await import('../../instrument.server.mjs');

    expect(process.listeners('uncaughtException')).toEqual(uncaughtBefore);
    expect(process.listeners('unhandledRejection')).toEqual(rejectionBefore);
    expect(processMetaListeners.listeners('newListener')).toEqual(metaBefore);

    const laterUncaughtListener = vi.fn();
    const laterRejectionListener = vi.fn();
    process.on('uncaughtException', laterUncaughtListener);
    process.on('unhandledRejection', laterRejectionListener);
    await Promise.resolve();

    expect(process.listeners('uncaughtException')).toContain(
      laterUncaughtListener
    );
    expect(process.listeners('unhandledRejection')).toContain(
      laterRejectionListener
    );
  });

  it('removes only the Nitro bootstrap fatal listeners', async () => {
    await import('../../instrument.server.mjs');
    const nitroUncaughtListener = vi.fn();
    const nitroRejectionListener = vi.fn();

    process.on('uncaughtException', nitroUncaughtListener);
    process.on('unhandledRejection', nitroRejectionListener);
    await Promise.resolve();

    expect(process.listeners('uncaughtException')).not.toContain(
      nitroUncaughtListener
    );
    expect(process.listeners('unhandledRejection')).not.toContain(
      nitroRejectionListener
    );
    expect(
      globalThis[
        Symbol.for('start-ui-web.telemetry.fatal-owner-ready') as never
      ]
    ).toBe(true);

    const laterMonitoringListener = vi.fn();
    process.on('uncaughtException', laterMonitoringListener);
    await Promise.resolve();

    expect(process.listeners('uncaughtException')).toContain(
      laterMonitoringListener
    );
  });

  it('bounds the Nitro listener guard when only one bootstrap listener appears', async () => {
    await import('../../instrument.server.mjs');
    const nitroUncaughtListener = vi.fn();

    process.on('uncaughtException', nitroUncaughtListener);
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(process.listeners('uncaughtException')).not.toContain(
      nitroUncaughtListener
    );
    expect(
      globalThis[
        Symbol.for('start-ui-web.telemetry.fatal-owner-ready') as never
      ]
    ).toBe(true);

    const laterRejectionListener = vi.fn();
    process.on('unhandledRejection', laterRejectionListener);
    await Promise.resolve();

    expect(process.listeners('unhandledRejection')).toContain(
      laterRejectionListener
    );
  });

  it('does not abort optional server bootstrap when Sentry initialization fails', async () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    sentry.init.mockImplementationOnce(() => {
      throw new Error('Sentry unavailable');
    });

    await expect(import('../../instrument.server.mjs')).resolves.toBeDefined();
    const { isServerSentryInstrumentationReady } =
      await import('@/platform/telemetry/instrumentation-readiness');

    expect(globalThis.console.error).toHaveBeenCalledWith(
      'telemetry.report_failure',
      expect.objectContaining({
        errorType: 'Error',
        source: 'sentry.instrumentation',
      })
    );
    expect(process.listenerCount('uncaughtException')).toBe(
      originalUncaughtExceptionListeners.size + 1
    );
    expect(process.listenerCount('unhandledRejection')).toBe(
      originalUnhandledRejectionListeners.size + 1
    );
    expect(isServerSentryInstrumentationReady()).toBe(false);
  });

  it('does not initialize server Sentry from the browser-public DSN', async () => {
    delete process.env.SENTRY_DSN;

    await import('../../instrument.server.mjs');

    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.setNodeAsyncContextStrategy).not.toHaveBeenCalled();
    expect(process.listenerCount('uncaughtException')).toBe(
      originalUncaughtExceptionListeners.size + 1
    );
    expect(process.listenerCount('unhandledRejection')).toBe(
      originalUnhandledRejectionListeners.size + 1
    );
  });

  it('installs only explicit exception integrations in the real Node SDK', () => {
    const instrumentationUrl = pathToFileURL(
      path.join(process.cwd(), 'instrument.server.mjs')
    ).href;
    const script = `
      process.env.SENTRY_DSN = 'https://public@example.com/1';
      await import(${JSON.stringify(instrumentationUrl)});
      const Sentry = await import('@sentry/node');
      const client = Sentry.getClient();
      process.stdout.write(JSON.stringify({
        defaultIntegrations: client?.getOptions().defaultIntegrations,
        integrations: client?.getOptions().integrations?.map(({ name }) => name),
      }));
      await Sentry.close(100);
    `;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test' },
        killSignal: 'SIGKILL',
        timeout: 10_000,
      }
    );

    expect(result.error).toBeUndefined();
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
    expect(JSON.parse(result.stdout)).toEqual({
      defaultIntegrations: false,
      integrations: ['EventFilters', 'LinkedErrors'],
    });
  });

  it('isolates Sentry role scope across concurrent real Node requests', () => {
    const instrumentationUrl = pathToFileURL(
      path.join(process.cwd(), 'instrument.server.mjs')
    ).href;
    const adapterUrl = pathToFileURL(
      path.join(process.cwd(), 'src/composition/telemetry/sentry-adapter.ts')
    ).href;
    const requestContextUrl = pathToFileURL(
      path.join(
        process.cwd(),
        'src/composition/telemetry/sentry-node-request-context.ts'
      )
    ).href;
    const script = `
      const { createServer } = await import('node:http');
      const envelopes = [];
      const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        envelopes.push(Buffer.concat(chunks).toString('utf8'));
        response.end('ok');
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      process.env.SENTRY_DSN = 'http://public@127.0.0.1:' + address.port + '/1';
      await import(${JSON.stringify(instrumentationUrl)});
      const Sentry = await import('@sentry/node');
      const { initializeSentryNodeRequestContext, runWithSentryNodeRequestIsolation } =
        await import(${JSON.stringify(requestContextUrl)});
      const requestContext = await initializeSentryNodeRequestContext();
      if (!requestContext) throw new Error('request context unavailable');
      const { createSentryTelemetryAdapter } = await import(${JSON.stringify(adapterUrl)});
      const adapter = createSentryTelemetryAdapter(Sentry);
      let releaseAdmin;
      const userReady = new Promise((resolve) => {
        releaseAdmin = resolve;
      });
      await Promise.all([
        runWithSentryNodeRequestIsolation(async () => {
          adapter.setUser({ id: 'admin-id-secret', role: 'admin' });
          await userReady;
          adapter.captureException(new Error('admin-exception-secret'));
        }),
        runWithSentryNodeRequestIsolation(async () => {
          adapter.setUser({ id: 'user-id-secret', role: 'user' });
          releaseAdmin();
          await new Promise((resolve) => setImmediate(resolve));
          adapter.captureException(new Error('user-exception-secret'));
        }),
      ]);
      await Sentry.flush(2_000);
      await new Promise((resolve) => setImmediate(resolve));
      requestContext.release();
      await new Promise((resolve) => server.close(resolve));
      process.stdout.write(JSON.stringify(envelopes));
    `;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test' },
        killSignal: 'SIGKILL',
        timeout: 10_000,
      }
    );

    expect(result.error).toBeUndefined();
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
    const envelopes = JSON.parse(result.stdout) as string[];
    expect(envelopes).toHaveLength(2);
    expect(
      envelopes.filter((body) => body.includes('"role":"admin"'))
    ).toHaveLength(1);
    expect(
      envelopes.filter((body) => body.includes('"role":"user"'))
    ).toHaveLength(1);
    expect(JSON.stringify(envelopes)).not.toMatch(
      /admin-exception-secret|admin-id-secret|user-exception-secret|user-id-secret/u
    );
  });

  it.each([
    ['uncaught exception', 'runtime.uncaught_exception', 'throw'],
    ['unhandled rejection', 'runtime.unhandled_rejection', 'reject'],
  ] as const)(
    'sanitizes and terminates a real Node %s',
    async (_label, expectedSource, failureMode) => {
      const result = await runFatalProcessProbe(failureMode, 'respond');
      expect(result).toMatchObject({ code: 1, signal: null });
      expect(result.stderr).toContain('runtime.fatal');
      expect(result.stderr).toContain(expectedSource);
      expect(result.stderr).toContain('Error');
      expect(result.stderr).not.toContain(result.secret);
      expect(result.envelopes).toHaveLength(1);
      const envelope = decodedEnvelope(result.envelopes[0]!);
      expect(envelope).toContain('Unexpected application error');
      expect(envelope).not.toContain(result.secret);
    },
    15_000
  );

  it.each([
    ['uncaught exception', 'runtime.uncaught_exception', 'throw'],
    ['unhandled rejection', 'runtime.unhandled_rejection', 'reject'],
  ] as const)(
    'sanitizes and terminates a real Node %s without a Sentry DSN',
    async (_label, expectedSource, failureMode) => {
      const result = await runFatalProcessProbe(failureMode, 'off');

      expect(result).toMatchObject({ code: 1, signal: null, envelopes: [] });
      expect(result.stderr).toContain('runtime.fatal');
      expect(result.stderr).toContain(expectedSource);
      expect(result.stderr).toContain('Error');
      expect(result.stderr).not.toContain(result.secret);
    },
    15_000
  );

  it('bounds fatal exit when the Sentry collector hangs', async () => {
    const result = await runFatalProcessProbe('throw', 'hang');

    expect(result).toMatchObject({ code: 1, signal: null });
    expect(result.stderr).not.toContain(result.secret);
    expect(result.envelopes).toHaveLength(1);
    expect(decodedEnvelope(result.envelopes[0]!)).not.toContain(result.secret);
    expect(result.durationMs).toBeGreaterThan(1_500);
    expect(result.durationMs).toBeLessThan(6_000);
  }, 15_000);
});
