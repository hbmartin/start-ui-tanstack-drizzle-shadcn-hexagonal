import { Result } from '@bloodyowl/boxed';
import { describe, expect, it, vi } from 'vitest';

import type {
  Logger,
  OutboxEventRecord,
  OutboxRepository,
} from '@/modules/kernel';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { toOutboxEventId } from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';
import {
  createConsumerRegistry,
  createLifecycleEventsUseCases,
  type LifecycleEventConsumer,
  type LifecycleEventsResult,
  type LifecycleEventsUseCaseDeps,
  type OutboxDrainOutcome,
} from '@/modules/lifecycle-events';

const now = new Date('2026-01-01T00:00:00.000Z');

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const makeEventRecord = (
  overrides: Partial<OutboxEventRecord> = {}
): OutboxEventRecord => ({
  id: unwrapParseResult(toOutboxEventId('outbox-1')),
  type: 'book.created',
  aggregateType: 'book',
  aggregateId: 'book-1',
  payload: { bookId: 'book-1', title: 'Dune', author: 'Frank Herbert' },
  deployTarget: 'test-target',
  status: 'pending',
  attempts: 0,
  availableAt: now,
  publishedAt: null,
  lastError: null,
  dedupeKey: null,
  createdAt: now,
  ...overrides,
});

const makeOutboxRepository = (
  overrides: Partial<OutboxRepository> = {}
): OutboxRepository =>
  ({
    record: vi.fn(),
    claimBatch: vi.fn(async () =>
      Result.Ok({ type: 'outbox_batch_claimed' as const, records: [] })
    ),
    markPublished: vi.fn(async () =>
      Result.Ok({ type: 'outbox_event_published' as const })
    ),
    markFailed: vi.fn(async () =>
      Result.Ok({ type: 'outbox_event_failure_recorded' as const })
    ),
    ...overrides,
  }) as OutboxRepository;

const makeConsumer = (
  overrides: Partial<LifecycleEventConsumer> = {}
): LifecycleEventConsumer => ({
  name: 'test-consumer',
  handles: () => true,
  consume: vi.fn(async () =>
    Result.Ok({ type: 'lifecycle_event_consumed' as const })
  ),
  ...overrides,
});

const makeDeps = (input: {
  outboxRepository: OutboxRepository;
  consumers?: LifecycleEventConsumer[];
  drainBatchSize?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
}): LifecycleEventsUseCaseDeps => ({
  transactionRunner: {
    run: (work) => work({ outboxRepository: input.outboxRepository }),
  },
  consumerRegistry: createConsumerRegistry(input.consumers ?? [makeConsumer()]),
  clock: { now: () => now },
  logger,
  drainBatchSize: input.drainBatchSize ?? 10,
  maxAttempts: input.maxAttempts ?? 3,
  baseBackoffMs: input.baseBackoffMs ?? 1000,
});

function getOk(
  result: LifecycleEventsResult<OutboxDrainOutcome>
): OutboxDrainOutcome {
  if (result.isError()) throw result.getError();
  return result.get();
}

describe('drainOutbox', () => {
  it('publishes claimed events after all consumers succeed', async () => {
    const record = makeEventRecord();
    const consumer = makeConsumer();
    const outboxRepository = makeOutboxRepository({
      claimBatch: vi.fn(async () =>
        Result.Ok({ type: 'outbox_batch_claimed' as const, records: [record] })
      ),
    });

    const result = await createLifecycleEventsUseCases(
      makeDeps({ outboxRepository, consumers: [consumer] })
    ).drain();

    expect(getOk(result)).toEqual({
      type: 'outbox_drained',
      claimed: 1,
      published: 1,
      retried: 0,
      exhausted: 0,
    });
    expect(consumer.consume).toHaveBeenCalledWith(record);
    expect(outboxRepository.markPublished).toHaveBeenCalledWith({
      id: record.id,
      publishedAt: now,
    });
    expect(outboxRepository.markFailed).not.toHaveBeenCalled();
  });

  it('skips consumers that do not handle the event type', async () => {
    const record = makeEventRecord();
    const matching = makeConsumer({ name: 'matching' });
    const nonMatching = makeConsumer({
      name: 'non-matching',
      handles: (eventType) => eventType === 'user.created',
    });
    const outboxRepository = makeOutboxRepository({
      claimBatch: vi.fn(async () =>
        Result.Ok({ type: 'outbox_batch_claimed' as const, records: [record] })
      ),
    });

    await createLifecycleEventsUseCases(
      makeDeps({ outboxRepository, consumers: [matching, nonMatching] })
    ).drain();

    expect(matching.consume).toHaveBeenCalledOnce();
    expect(nonMatching.consume).not.toHaveBeenCalled();
  });

  it('reschedules a failed event with exponential backoff', async () => {
    const record = makeEventRecord({ attempts: 1 });
    const consumer = makeConsumer({
      consume: vi.fn(async () =>
        Result.Error(
          new AppError({
            code: 'CONSUMER_FAILED',
            category: 'system',
            status: 500,
            message: 'boom',
          })
        )
      ),
    });
    const outboxRepository = makeOutboxRepository({
      claimBatch: vi.fn(async () =>
        Result.Ok({ type: 'outbox_batch_claimed' as const, records: [record] })
      ),
    });

    const result = await createLifecycleEventsUseCases(
      makeDeps({
        outboxRepository,
        consumers: [consumer],
        maxAttempts: 3,
        baseBackoffMs: 1000,
      })
    ).drain();

    expect(getOk(result)).toMatchObject({ retried: 1, exhausted: 0 });
    // Second attempt: base * 2^(2-1) = 2s after "now".
    expect(outboxRepository.markFailed).toHaveBeenCalledWith({
      id: record.id,
      error: 'test-consumer: boom',
      nextAttemptAt: new Date(now.getTime() + 2000),
    });
  });

  it('marks an event terminally failed once attempts are exhausted', async () => {
    const record = makeEventRecord({ attempts: 2 });
    const consumer = makeConsumer({
      consume: vi.fn(async () => {
        throw new Error('kaput');
      }),
    });
    const outboxRepository = makeOutboxRepository({
      claimBatch: vi.fn(async () =>
        Result.Ok({ type: 'outbox_batch_claimed' as const, records: [record] })
      ),
    });

    const result = await createLifecycleEventsUseCases(
      makeDeps({ outboxRepository, consumers: [consumer], maxAttempts: 3 })
    ).drain();

    expect(getOk(result)).toMatchObject({ retried: 0, exhausted: 1 });
    expect(outboxRepository.markFailed).toHaveBeenCalledWith({
      id: record.id,
      error: 'test-consumer: kaput',
      nextAttemptAt: null,
    });
  });

  it('keeps draining batches until a batch comes back short', async () => {
    const claimBatch = vi
      .fn()
      .mockResolvedValueOnce(
        Result.Ok({
          type: 'outbox_batch_claimed' as const,
          records: [
            makeEventRecord({
              id: unwrapParseResult(toOutboxEventId('outbox-1')),
            }),
            makeEventRecord({
              id: unwrapParseResult(toOutboxEventId('outbox-2')),
            }),
          ],
        })
      )
      .mockResolvedValueOnce(
        Result.Ok({
          type: 'outbox_batch_claimed' as const,
          records: [
            makeEventRecord({
              id: unwrapParseResult(toOutboxEventId('outbox-3')),
            }),
          ],
        })
      );
    const outboxRepository = makeOutboxRepository({ claimBatch });

    const result = await createLifecycleEventsUseCases(
      makeDeps({ outboxRepository, drainBatchSize: 2 })
    ).drain();

    expect(getOk(result)).toMatchObject({ claimed: 3, published: 3 });
    expect(claimBatch).toHaveBeenCalledTimes(2);
  });

  it('maps repository failures to a Result error', async () => {
    const error = new AppError({
      code: 'OUTBOX_REPOSITORY_ERROR',
      category: 'system',
      status: 500,
      message: 'Outbox repository error',
    });
    const outboxRepository = makeOutboxRepository({
      claimBatch: vi.fn(async () => Result.Error(error)),
    });

    const result = await createLifecycleEventsUseCases(
      makeDeps({ outboxRepository })
    ).drain();

    if (result.isOk()) {
      throw new Error(`Expected Result.Error, got ${result.get().type}`);
    }
    expect(result.getError()).toBe(error);
  });
});
