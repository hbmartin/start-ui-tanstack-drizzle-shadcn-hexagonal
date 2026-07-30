import { Result } from '@bloodyowl/boxed';

import type { OutboxEventRecord } from '@/modules/kernel';
import { AppError } from '@/modules/kernel/domain/errors/app-error';

import type {
  LifecycleEventsResult,
  LifecycleEventsUseCaseDeps,
  OutboxDrainOutcome,
} from './types';

/** Bounds a single drain request; the host cron catches up on the next hit. */
const MAX_BATCHES_PER_DRAIN = 20;

/** Caps exponential backoff at base * 2^6 so retries stay within hours. */
const MAX_BACKOFF_DOUBLINGS = 6;

const backoffMs = (baseBackoffMs: number, attempts: number) =>
  baseBackoffMs * 2 ** Math.min(attempts - 1, MAX_BACKOFF_DOUBLINGS);

/**
 * Delivers one event to every registered consumer. Returns `undefined` when
 * all consumers succeeded, else a failure description for the outbox row.
 * Consumer errors (returned or thrown) never abort the batch — they schedule
 * a retry for this event only.
 */
async function dispatchToConsumers(
  deps: LifecycleEventsUseCaseDeps,
  event: OutboxEventRecord
): Promise<string | undefined> {
  const failures: string[] = [];

  for (const consumer of deps.consumerRegistry.consumersFor(event.type)) {
    try {
      const consumed = await consumer.consume(event);
      if (consumed.isError()) {
        failures.push(`${consumer.name}: ${consumed.getError().message}`);
      }
    } catch (error) {
      failures.push(
        `${consumer.name}: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }
  }

  return failures.length === 0 ? undefined : failures.join('; ');
}

/**
 * Claims due pending outbox events with `FOR UPDATE SKIP LOCKED`, dispatches
 * them to registered consumers, and marks each published or rescheduled with
 * capped exponential backoff — all inside one transaction per batch, so
 * concurrent drains never double-process a row. Delivery is at-least-once: a
 * crash after a consumer ran but before commit replays the event.
 */
export async function drainOutbox(
  deps: LifecycleEventsUseCaseDeps
): Promise<LifecycleEventsResult<OutboxDrainOutcome>> {
  const totals = { claimed: 0, published: 0, retried: 0, exhausted: 0 };

  try {
    for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch += 1) {
      const processed = await deps.transactionRunner.run(
        async ({ outboxRepository }) => {
          const claimed = await outboxRepository.claimBatch({
            limit: deps.drainBatchSize,
            now: deps.clock.now(),
          });
          if (claimed.isError()) throw claimed.getError();

          const { records } = claimed.get();
          for (const record of records) {
            const failure = await dispatchToConsumers(deps, record);

            if (failure === undefined) {
              const published = await outboxRepository.markPublished({
                id: record.id,
                publishedAt: deps.clock.now(),
              });
              if (published.isError()) throw published.getError();
              totals.published += 1;
              continue;
            }

            const attempts = record.attempts + 1;
            const exhausted = attempts >= deps.maxAttempts;
            const marked = await outboxRepository.markFailed({
              id: record.id,
              error: failure,
              nextAttemptAt: exhausted
                ? null
                : new Date(
                    deps.clock.now().getTime() +
                      backoffMs(deps.baseBackoffMs, attempts)
                  ),
            });
            if (marked.isError()) throw marked.getError();

            if (exhausted) {
              totals.exhausted += 1;
              deps.logger.warn({
                event: 'lifecycle.outbox_event_exhausted',
                details: {
                  outboxEventId: record.id,
                  eventType: record.type,
                  attempts,
                  lastError: failure,
                },
              });
            } else {
              totals.retried += 1;
            }
          }

          return records.length;
        }
      );

      totals.claimed += processed;
      if (processed < deps.drainBatchSize) break;
    }

    return Result.Ok({ type: 'outbox_drained', ...totals });
  } catch (error) {
    return Result.Error(
      error instanceof AppError
        ? error
        : new AppError({
            code: 'OUTBOX_DRAIN_TRANSACTION_ERROR',
            category: 'system',
            status: 500,
            message: 'Outbox drain transaction error',
            cause: error,
          })
    );
  }
}
