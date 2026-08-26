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
  it('rejects an unrelated global manager for provider-specific acceptance', () => {
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

  it('reuses a functional preinstalled Node context without taking ownership', () => {
    const result = runProbe(`
      const { context, createContextKey } = await import('@opentelemetry/api');
      const Sentry = await import('@sentry/node');
      const { initializeSentryNodeRequestContext } =
        await import(${JSON.stringify(requestContextUrl)});
      Sentry.setNodeAsyncContextStrategy();
      const preinstalled = new Sentry.SentryContextManager();
      preinstalled.enable();
      if (!context.setGlobalContextManager(preinstalled)) {
        throw new Error('preinstalled test context unavailable');
      }
      const claim = await initializeSentryNodeRequestContext();
      if (!claim) throw new Error('functional preinstalled context was rejected');
      const key = createContextKey('preinstalled-context-test');
      const marker = {};
      const propagates = () => {
        let active = false;
        context.with(context.active().setValue(key, marker), () => {
          active = context.active().getValue(key) === marker;
        });
        return active;
      };
      const beforeRelease = propagates();
      claim.release();
      const afterRelease = propagates();
      context.disable();
      process.stdout.write(JSON.stringify({ afterRelease, beforeRelease }));
    `);

    expect(result.error).toBeUndefined();
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
    expect(JSON.parse(result.stdout)).toEqual({
      afterRelease: true,
      beforeRelease: true,
    });
  });

  it('rejects a synchronous stack manager that loses concurrent async context', () => {
    const result = runProbe(`
      const { context, ROOT_CONTEXT } = await import('@opentelemetry/api');
      const { initializeSentryNodeRequestContext } =
        await import(${JSON.stringify(requestContextUrl)});
      class StackContextManager {
        stack = [];
        active() {
          return this.stack.at(-1) ?? ROOT_CONTEXT;
        }
        bind(_context, target) {
          return target;
        }
        disable() {
          this.stack = [];
          return this;
        }
        enable() {
          return this;
        }
        with(activeContext, operation, thisArg, ...args) {
          this.stack.push(activeContext);
          try {
            return operation.call(thisArg, ...args);
          } finally {
            this.stack.pop();
          }
        }
      }
      const preinstalled = new StackContextManager();
      if (!context.setGlobalContextManager(preinstalled)) {
        throw new Error('preinstalled stack context unavailable');
      }
      const claim = await initializeSentryNodeRequestContext();
      context.disable();
      process.stdout.write(JSON.stringify({ claim: Boolean(claim) }));
    `);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ claim: false });
  });

  it('rejects a generic async manager that does not isolate Sentry scopes', () => {
    const result = runProbe(`
      const { AsyncLocalStorage } = await import('node:async_hooks');
      const { context, ROOT_CONTEXT } = await import('@opentelemetry/api');
      const { initializeSentryNodeRequestContext } =
        await import(${JSON.stringify(requestContextUrl)});
      class GenericAsyncContextManager {
        storage = new AsyncLocalStorage();
        active() {
          return this.storage.getStore() ?? ROOT_CONTEXT;
        }
        bind(_context, target) {
          return target;
        }
        disable() {
          this.storage.disable();
          return this;
        }
        enable() {
          return this;
        }
        with(activeContext, operation, thisArg, ...args) {
          return this.storage.run(
            activeContext,
            operation.bind(thisArg, ...args)
          );
        }
      }
      const preinstalled = new GenericAsyncContextManager().enable();
      if (!context.setGlobalContextManager(preinstalled)) {
        throw new Error('preinstalled async context unavailable');
      }
      const claim = await initializeSentryNodeRequestContext();
      context.disable();
      process.stdout.write(JSON.stringify({ claim: Boolean(claim) }));
    `);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ claim: false });
  });

  it('degrades safely when a hostile preinstalled manager throws during probing', () => {
    const result = runProbe(`
      const { context } = await import('@opentelemetry/api');
      const { initializeSentryNodeRequestContext } =
        await import(${JSON.stringify(requestContextUrl)});
      const hostile = {
        active() {
          throw new Error('hostile active');
        },
        bind(_context, target) {
          return target;
        },
        disable() {
          return this;
        },
        enable() {
          return this;
        },
        with() {
          throw new Error('hostile with');
        },
      };
      if (!context.setGlobalContextManager(hostile)) {
        throw new Error('hostile test context unavailable');
      }
      const claim = await initializeSentryNodeRequestContext();
      context.disable();
      process.stdout.write(JSON.stringify({ claim: Boolean(claim) }));
    `);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ claim: false });
  });

  it('bounds a preinstalled manager that never completes a context operation', () => {
    const result = runProbe(`
      const { context, ROOT_CONTEXT } = await import('@opentelemetry/api');
      const { initializeSentryNodeRequestContext } =
        await import(${JSON.stringify(requestContextUrl)});
      const stalled = {
        active() {
          return ROOT_CONTEXT;
        },
        bind(_context, target) {
          return target;
        },
        disable() {
          return this;
        },
        enable() {
          return this;
        },
        with() {
          return new Promise(() => undefined);
        },
      };
      if (!context.setGlobalContextManager(stalled)) {
        throw new Error('stalled test context unavailable');
      }
      const startedAt = Date.now();
      const claim = await initializeSentryNodeRequestContext();
      const elapsedMs = Date.now() - startedAt;
      context.disable();
      process.stdout.write(JSON.stringify({ claim: Boolean(claim), elapsedMs }));
    `);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      claim: boolean;
      elapsedMs: number;
    };
    expect(output.claim).toBe(false);
    expect(output.elapsedMs).toBeGreaterThanOrEqual(200);
    expect(output.elapsedMs).toBeLessThan(2_000);
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
