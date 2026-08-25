import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UpstashSecondaryStore } from '@/modules/auth/infrastructure/secondary-store/upstash-secondary-store';
import type { ApplicationResult } from '@/modules/kernel/testing';
import type { TelemetryAdapter } from '@/platform/telemetry';

const captureException = vi.fn();
const telemetry = { captureException } as unknown as Pick<
  TelemetryAdapter,
  'captureException'
>;

const config = {
  restUrl: 'https://redis.example.com',
  restToken: 'token-123',
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const setDeleteFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
  const command = JSON.parse(String(init?.body)) as unknown[];
  return jsonResponse({ result: command[0] === 'DEL' ? 1 : 'OK' });
};

const expectOk = async <TOutcome extends { type: string }>(
  value: Promise<ApplicationResult<TOutcome>>,
  expected: TOutcome
) => {
  const result = await value;
  if (result.isError()) throw result.getError();
  expect(result.get()).toEqual(expected);
};

const expectErrorCode = async <TOutcome extends { type: string }>(
  value: Promise<ApplicationResult<TOutcome>>,
  code: string
) => {
  const result = await value;
  if (result.isOk()) {
    throw new Error(`Expected ${code} error, received ${result.get().type}.`);
  }
  expect(result.getError()).toMatchObject({ code });
};

describe('UpstashSecondaryStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects injected URL credentials before issuing a request', () => {
    const fetchFn = vi.fn();

    expect(
      () =>
        new UpstashSecondaryStore({
          config: {
            restToken: 'token',
            restUrl: 'https://user:secret@redis.example.com',
          },
          fetchFn,
          telemetry,
        })
    ).toThrow('must not contain URL credentials');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('consumes rate limits with one atomic EVAL command', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ result: [1, -1] }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectOk(store.consumeRateLimit('rate-key', { max: 3, window: 60 }), {
      type: 'secondary_store_rate_limit_consumed',
      allowed: true,
      retryAfter: null,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      config.restUrl,
      expect.objectContaining({
        body: expect.stringContaining('"EVAL"'),
      })
    );
    expect(fetchFn).toHaveBeenCalledWith(
      config.restUrl,
      expect.objectContaining({
        body: expect.stringContaining('"rate-key"'),
      })
    );
    expect(fetchFn).toHaveBeenCalledWith(
      config.restUrl,
      expect.objectContaining({
        body: expect.stringContaining('data.count < 0'),
      })
    );
  });

  it('returns bounded retry metadata for an exhausted rate limit', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ result: [0, 17] }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectOk(store.consumeRateLimit('rate-key', { max: 3, window: 60 }), {
      type: 'secondary_store_rate_limit_consumed',
      allowed: false,
      retryAfter: 17,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('fails closed and reports malformed rate-limit decisions', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ result: [1, 30] }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectErrorCode(
      store.consumeRateLimit('rate-key', { max: 3, window: 60 }),
      'AUTH_SECONDARY_STORE_UPSTASH_ERROR'
    );
    expect(captureException).toHaveBeenCalledOnce();
  });

  it('issues a GET command and returns the stored value', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ result: 'value-1' }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectOk(store.get('key-1'), {
      type: 'secondary_store_hit',
      value: 'value-1',
    });
    expect(fetchFn).toHaveBeenCalledWith(
      config.restUrl,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Bearer ${config.restToken}`,
        }),
        body: JSON.stringify(['GET', 'key-1']),
      })
    );
  });

  it('treats a null result as a miss', async () => {
    expect.hasAssertions();

    const fetchFn = vi.fn(async () => jsonResponse({ result: null }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectOk(store.get('absent'), { type: 'secondary_store_miss' });
  });

  it('sends SET with an EX ttl and DEL commands', async () => {
    const fetchFn = vi.fn(setDeleteFetch);
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectOk(store.set('key-1', 'value-1', 60), {
      type: 'secondary_store_set',
    });
    expect(fetchFn).toHaveBeenLastCalledWith(
      config.restUrl,
      expect.objectContaining({
        body: JSON.stringify(['SET', 'key-1', 'value-1', 'EX', 60]),
      })
    );

    await expectOk(store.set('key-2', 'value-2'), {
      type: 'secondary_store_set',
    });
    expect(fetchFn).toHaveBeenLastCalledWith(
      config.restUrl,
      expect.objectContaining({
        body: JSON.stringify(['SET', 'key-2', 'value-2']),
      })
    );

    await expectOk(store.delete('key-1'), {
      type: 'secondary_store_deleted',
    });
    expect(fetchFn).toHaveBeenLastCalledWith(
      config.restUrl,
      expect.objectContaining({
        body: JSON.stringify(['DEL', 'key-1']),
      })
    );
  });

  it('takes a matching value with one EVAL command', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ result: 'value-1' }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectOk(store.take('key-1', 'value-1'), {
      type: 'secondary_store_taken',
      value: 'value-1',
    });

    expect(fetchFn).toHaveBeenCalledWith(
      config.restUrl,
      expect.objectContaining({
        body: expect.stringContaining('"EVAL"'),
      })
    );
    expect(fetchFn).toHaveBeenCalledWith(
      config.restUrl,
      expect.objectContaining({
        body: expect.stringContaining('"key-1"'),
      })
    );
    expect(fetchFn).toHaveBeenCalledWith(
      config.restUrl,
      expect.objectContaining({
        body: expect.stringContaining('"value-1"'),
      })
    );
  });

  it('treats a non-matching take as a miss', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ result: null }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    const result = await store.take('key-1', 'value-1');

    expect(result).toMatchObject({
      tag: 'Ok',
      value: { type: 'secondary_store_miss' },
    });
  });

  it('fails closed when the take script returns a different value', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ result: 'attacker-controlled-value' })
    );
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectErrorCode(
      store.take('key-1', 'value-1'),
      'AUTH_SECONDARY_STORE_UPSTASH_ERROR'
    );
    expect(captureException).toHaveBeenCalledOnce();
  });

  it('fails closed when single-key deletion reports more than one key', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ result: 2 }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectErrorCode(
      store.delete('key-1'),
      'AUTH_SECONDARY_STORE_UPSTASH_ERROR'
    );
    expect(captureException).toHaveBeenCalledOnce();
  });

  it('returns and reports read failures on transport errors', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    });
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectErrorCode(
      store.get('key-1'),
      'AUTH_SECONDARY_STORE_UPSTASH_ERROR'
    );
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('returns and reports write failures', async () => {
    const fetchFn = vi.fn(async () => new Response('boom', { status: 500 }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectErrorCode(
      store.set('key-1', 'value-1'),
      'AUTH_SECONDARY_STORE_UPSTASH_ERROR'
    );
    await expectErrorCode(
      store.delete('key-1'),
      'AUTH_SECONDARY_STORE_UPSTASH_ERROR'
    );
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['get', (store: UpstashSecondaryStore) => store.get('key-1'), 42],
    [
      'set',
      (store: UpstashSecondaryStore) => store.set('key-1', 'value'),
      null,
    ],
    ['take', (store: UpstashSecondaryStore) => store.take('key-1', 'value'), 1],
    ['delete', (store: UpstashSecondaryStore) => store.delete('key-1'), -1],
  ] as const)(
    'fails closed and reports an invalid %s command response',
    async (_operation, execute, result) => {
      const fetchFn = vi.fn(async () => jsonResponse({ result }));
      const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

      const outcome = await execute(store);
      expect(outcome).toMatchObject({
        tag: 'Error',
        error: { code: 'AUTH_SECONDARY_STORE_UPSTASH_ERROR' },
      });
      expect(captureException).toHaveBeenCalledOnce();
    }
  );

  it('rejects a successful HTTP response without an Upstash result envelope', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectErrorCode(
      store.get('key-1'),
      'AUTH_SECONDARY_STORE_UPSTASH_ERROR'
    );
    expect(captureException).toHaveBeenCalledOnce();
  });

  it('aborts slow Upstash requests', async () => {
    const fetchFn = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
    );
    const store = new UpstashSecondaryStore({
      config,
      fetchFn,
      timeoutMs: 1,
      telemetry,
    });

    await expectErrorCode(
      store.get('key-1'),
      'AUTH_SECONDARY_STORE_UPSTASH_ERROR'
    );
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid ttl values before issuing a request', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ result: 'OK' }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectErrorCode(
      store.set('key-1', 'value-1', Number.NaN),
      'AUTH_SECONDARY_STORE_INVALID_TTL'
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
