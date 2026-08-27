import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '@/modules/kernel/infrastructure/db/types';

const mocks = vi.hoisted(() => ({
  createDatabase: vi.fn(),
  getScopedDatabase: vi.fn(),
  validateServerConfig: vi.fn(),
}));

vi.mock('@/modules/kernel/backend', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const databaseScope = new AsyncLocalStorage<Database>();
  mocks.getScopedDatabase.mockImplementation(() => databaseScope.getStore());

  return {
    createHyperdriveDbClient: mocks.createDatabase,
    runWithRuntimeDatabaseClient: <T>(database: Database, operation: () => T) =>
      databaseScope.run(database, operation),
    validateServerConfig: mocks.validateServerConfig,
  };
});

import {
  bindCloudflareDatabaseToResponse,
  runWithCloudflareDatabase,
} from '@/runtime/cloudflare/database-request';
import { takeRequestCompletions } from '@/runtime/request-completion';

const createDatabase = (adapter = 'hyperdrive') =>
  ({
    $adapter: adapter,
    $close: vi.fn(async () => undefined),
  }) as unknown as Database;

const settleRequest = (request: Request) =>
  Promise.allSettled(takeRequestCompletions(request));

describe('Cloudflare request database ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates the created adapter and scopes the whole handler', async () => {
    const database = createDatabase();
    const binding = { connectionString: 'postgresql://binding.internal/app' };
    const request = new Request('https://app.example.test/');
    const response = new Response(null, { status: 204 });
    mocks.createDatabase.mockResolvedValue(database);

    await expect(
      runWithCloudflareDatabase({
        binding,
        handle: async () => {
          await Promise.resolve();
          expect(mocks.getScopedDatabase()).toBe(database);
          return response;
        },
        request,
      })
    ).resolves.toBe(response);

    expect(mocks.createDatabase).toHaveBeenCalledWith(binding);
    expect(mocks.validateServerConfig).toHaveBeenCalledWith('cloudflare', {
      databaseAdapter: 'hyperdrive',
    });
    await settleRequest(request);
    expect(database.$close).toHaveBeenCalledOnce();
  });

  it('keeps concurrent request adapters isolated across awaits', async () => {
    const databaseA = createDatabase();
    const databaseB = createDatabase();
    mocks.createDatabase
      .mockResolvedValueOnce(databaseA)
      .mockResolvedValueOnce(databaseB);
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstHasStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const requestA = new Request('https://app.example.test/a');
    const requestB = new Request('https://app.example.test/b');

    const first = runWithCloudflareDatabase({
      binding: 'a',
      handle: async () => {
        firstStarted();
        await firstMayFinish;
        expect(mocks.getScopedDatabase()).toBe(databaseA);
        return new Response(null, { status: 204 });
      },
      request: requestA,
    });
    await firstHasStarted;
    const second = runWithCloudflareDatabase({
      binding: 'b',
      handle: async () => {
        await Promise.resolve();
        expect(mocks.getScopedDatabase()).toBe(databaseB);
        return new Response(null, { status: 204 });
      },
      request: requestB,
    });
    releaseFirst();

    await Promise.all([first, second]);
    await Promise.all([settleRequest(requestA), settleRequest(requestB)]);
    expect(databaseA.$close).toHaveBeenCalledOnce();
    expect(databaseB.$close).toHaveBeenCalledOnce();
  });

  it('preserves response semantics and closes only after stream EOF', async () => {
    const database = createDatabase();
    const request = new Request('https://app.example.test/stream');
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
        },
      }),
      {
        headers: { 'x-stream': 'preserved' },
        status: 206,
        statusText: 'Partial Content',
      }
    );

    const returned = bindCloudflareDatabaseToResponse({
      database,
      request,
      response: original,
    });

    expect(returned).not.toBe(original);
    expect(returned.status).toBe(206);
    expect(returned.statusText).toBe('Partial Content');
    expect(returned.headers.get('x-stream')).toBe('preserved');
    expect(database.$close).not.toHaveBeenCalled();

    source.enqueue(new TextEncoder().encode('streamed'));
    source.close();
    await expect(returned.text()).resolves.toBe('streamed');
    await settleRequest(request);
    expect(database.$close).toHaveBeenCalledOnce();
  });

  it('closes after consumer cancellation without draining the source', async () => {
    const database = createDatabase();
    const request = new Request('https://app.example.test/cancel');
    let sourceCancelled = false;
    const report = vi
      .spyOn(globalThis.console, 'error')
      .mockImplementation(() => undefined);
    const response = bindCloudflareDatabaseToResponse({
      database,
      request,
      response: new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            sourceCancelled = true;
          },
          pull(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
        })
      ),
    });

    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    await settleRequest(request);

    expect(sourceCancelled).toBe(true);
    expect(database.$close).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });

  it('closes after a producer error while preserving the stream failure', async () => {
    const database = createDatabase();
    const request = new Request('https://app.example.test/error');
    const streamFailure = new Error('producer failed');
    const response = bindCloudflareDatabaseToResponse({
      database,
      request,
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.error(streamFailure);
          },
        })
      ),
    });

    await expect(response.text()).rejects.toBe(streamFailure);
    await settleRequest(request);
    expect(database.$close).toHaveBeenCalledOnce();
  });

  it('preserves the application failure when cleanup also fails', async () => {
    const database = createDatabase();
    const closeFailure = new Error('close failed');
    vi.mocked(database.$close).mockRejectedValue(closeFailure);
    const applicationFailure = new Error('application failed');
    const report = vi
      .spyOn(globalThis.console, 'error')
      .mockImplementation(() => undefined);
    mocks.createDatabase.mockResolvedValue(database);

    await expect(
      runWithCloudflareDatabase({
        binding: {},
        handle: async () => {
          throw applicationFailure;
        },
        request: new Request('https://app.example.test/failure'),
      })
    ).rejects.toBe(applicationFailure);

    expect(database.$close).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith('telemetry.report_failure', {
      errorType: 'Error',
      source: 'database.cloudflare.close',
    });
  });

  it('fails fast and closes once when the response body is locked', async () => {
    const database = createDatabase();
    const response = new Response('locked');
    const reader = response.body?.getReader();
    mocks.createDatabase.mockResolvedValue(database);

    await expect(
      runWithCloudflareDatabase({
        binding: {},
        handle: () => response,
        request: new Request('https://app.example.test/locked'),
      })
    ).rejects.toThrow(
      new TypeError(
        'Cloudflare response body must be unused and unlocked before database binding'
      )
    );

    expect(database.$close).toHaveBeenCalledOnce();
    await reader?.cancel();
    reader?.releaseLock();
  });

  it('fails fast and closes once when the response body was consumed', async () => {
    const database = createDatabase();
    const response = new Response('consumed');
    await response.text();
    mocks.createDatabase.mockResolvedValue(database);

    await expect(
      runWithCloudflareDatabase({
        binding: {},
        handle: () => response,
        request: new Request('https://app.example.test/consumed'),
      })
    ).rejects.toThrow(
      new TypeError(
        'Cloudflare response body must be unused and unlocked before database binding'
      )
    );

    expect(database.$close).toHaveBeenCalledOnce();
  });

  it('does not run validation or the handler when binding creation fails', async () => {
    const connectionFailure = new Error('binding unavailable');
    const handle = vi.fn();
    mocks.createDatabase.mockRejectedValue(connectionFailure);

    await expect(
      runWithCloudflareDatabase({
        binding: undefined,
        handle,
        request: new Request('https://app.example.test/failure'),
      })
    ).rejects.toBe(connectionFailure);

    expect(mocks.validateServerConfig).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });
});
