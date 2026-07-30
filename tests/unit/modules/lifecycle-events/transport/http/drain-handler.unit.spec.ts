import { Result } from '@bloodyowl/boxed';
import { describe, expect, it, vi } from 'vitest';

import { createOutboxDrainHandlers } from '@/modules/lifecycle-events/transport/http/drain-handler';

const drainedOutcome = {
  type: 'outbox_drained' as const,
  claimed: 1,
  published: 1,
  retried: 0,
  exhausted: 0,
};

const makeRequest = (headers?: HeadersInit) =>
  new Request('https://example.test/api/tasks/outbox/drain', {
    method: 'POST',
    headers,
  });

describe('outbox drain HTTP handler', () => {
  it('responds 503 when no drain secret is configured', async () => {
    const drain = vi.fn();
    const logger = { warn: vi.fn() };
    const handlers = createOutboxDrainHandlers({
      getUseCases: () => ({ drain }),
      logger,
    });

    const response = await handlers.drain(
      makeRequest({ Authorization: 'Bearer anything' })
    );

    expect(response.status).toBe(503);
    expect(drain).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'security.outbox_drain_unconfigured' })
    );
  });

  it('rejects requests without a bearer token', async () => {
    const drain = vi.fn();
    const logger = { warn: vi.fn() };
    const handlers = createOutboxDrainHandlers({
      getUseCases: () => ({ drain }),
      drainSecret: 'top-secret',
      logger,
    });

    const response = await handlers.drain(makeRequest());

    expect(response.status).toBe(401);
    expect(drain).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'security.outbox_drain_unauthorized' })
    );
  });

  it.each([
    ['Bearer wrong-secret', 'wrong value'],
    ['Bearer top-secret-but-longer', 'wrong length'],
    ['Basic top-secret', 'wrong scheme'],
  ])('rejects %s (%s)', async (authorization) => {
    const drain = vi.fn();
    const handlers = createOutboxDrainHandlers({
      getUseCases: () => ({ drain }),
      drainSecret: 'top-secret',
    });

    const response = await handlers.drain(
      makeRequest({ Authorization: authorization })
    );

    expect(response.status).toBe(401);
    expect(drain).not.toHaveBeenCalled();
  });

  it('drains and reports counts with the correct secret', async () => {
    const drain = vi.fn(async () => Result.Ok(drainedOutcome));
    const handlers = createOutboxDrainHandlers({
      getUseCases: () => ({ drain }),
      drainSecret: 'top-secret',
    });

    const response = await handlers.drain(
      makeRequest({ Authorization: 'Bearer top-secret' })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      claimed: 1,
      published: 1,
      retried: 0,
      exhausted: 0,
    });
  });

  it('propagates drain use-case errors for the error mapper', async () => {
    const error = Object.assign(new Error('drain failed'), { status: 500 });
    const drain = vi.fn(async () => Result.Error(error) as never);
    const handlers = createOutboxDrainHandlers({
      getUseCases: () => ({ drain }),
      drainSecret: 'top-secret',
    });

    await expect(
      handlers.drain(makeRequest({ Authorization: 'Bearer top-secret' }))
    ).rejects.toBe(error);
  });
});
