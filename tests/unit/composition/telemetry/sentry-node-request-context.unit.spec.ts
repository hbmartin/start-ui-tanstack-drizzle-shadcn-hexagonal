import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const requestContextUrl = pathToFileURL(
  path.join(
    process.cwd(),
    'src/composition/telemetry/sentry-node-request-context.ts'
  )
).href;

const runProbe = (script: string) =>
  spawnSync(
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

describe('Sentry Node request context', () => {
  it('rejects an unrelated installed global context manager', () => {
    const result = runProbe(`
      const { context } = await import('@opentelemetry/api');
      const Sentry = await import('@sentry/node');
      const { claimSentryNodeRequestContext, createSentryNodeRequestContextManager } =
        await import(${JSON.stringify(requestContextUrl)});
      const unrelated = new Sentry.SentryContextManager();
      unrelated.enable();
      if (!context.setGlobalContextManager(unrelated)) {
        throw new Error('unrelated test context unavailable');
      }
      const candidate = createSentryNodeRequestContextManager();
      const claim = claimSentryNodeRequestContext(candidate, {
        acceptAlreadyInstalledByProvider: true,
      });
      process.stdout.write(JSON.stringify({ claim: Boolean(claim) }));
      unrelated.disable();
    `);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ claim: false });
  });

  it('integrates with the real Vercel trace owner without duplicate context registration', () => {
    const result = runProbe(`
      const diagnostics = [];
      const originalError = console.error;
      console.error = (...values) => diagnostics.push(values.map(String).join(' '));
      const Sentry = await import('@sentry/node');
      const { registerOTel } = await import('@vercel/otel');
      const {
        createSentryNodeRequestContextManager,
        isSentryNodeRequestContextActive,
        runWithSentryNodeRequestIsolation,
      } = await import(${JSON.stringify(requestContextUrl)});
      Sentry.setNodeAsyncContextStrategy();
      Sentry.init({
        defaultIntegrations: false,
        dsn: 'https://public@example.invalid/1',
        skipOpenTelemetrySetup: true,
      });
      const contextManager = createSentryNodeRequestContextManager();
      if (!contextManager) throw new Error('request context unavailable');
      registerOTel({
        contextManager,
        instrumentations: [],
        serviceName: 'start-ui-web-vercel-context-test',
      });
      if (!isSentryNodeRequestContextActive(contextManager)) {
        throw new Error('Vercel did not install the supplied context manager');
      }
      let releaseAdmin;
      const userReady = new Promise((resolve) => {
        releaseAdmin = resolve;
      });
      const roles = await Promise.all([
        runWithSentryNodeRequestIsolation(async () => {
          Sentry.getIsolationScope().setTag('role', 'admin');
          await userReady;
          return Sentry.getIsolationScope().getScopeData().tags?.role;
        }),
        runWithSentryNodeRequestIsolation(async () => {
          Sentry.getIsolationScope().setTag('role', 'user');
          releaseAdmin();
          await new Promise((resolve) => setImmediate(resolve));
          return Sentry.getIsolationScope().getScopeData().tags?.role;
        }),
      ]);
      await Sentry.close(100);
      contextManager.disable();
      console.error = originalError;
      process.stdout.write(JSON.stringify({ diagnostics, roles }));
    `);

    expect(result.error).toBeUndefined();
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
    const output = JSON.parse(result.stdout) as {
      diagnostics: string[];
      roles: string[];
    };
    expect(output.roles).toEqual(['admin', 'user']);
    expect(output.diagnostics.join('\n')).not.toContain(
      'Attempted duplicate registration of API: context'
    );
  });
});
