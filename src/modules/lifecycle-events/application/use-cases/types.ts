import type {
  ApplicationResult,
  Clock,
  Logger,
  OutboxRepository,
  TransactionRunner,
} from '@/modules/kernel';

import type { ConsumerRegistry } from '../consumers/consumer-registry';

export type LifecycleEventsTransactionContext = {
  outboxRepository: OutboxRepository;
};

export type LifecycleEventsUseCaseDeps = {
  transactionRunner: TransactionRunner<LifecycleEventsTransactionContext>;
  consumerRegistry: ConsumerRegistry;
  clock: Clock;
  logger: Logger;
  /** Events claimed per drain transaction. */
  drainBatchSize: number;
  /** Delivery attempts before an event is marked terminally failed. */
  maxAttempts: number;
  /** First retry delay; doubled per attempt (capped). */
  baseBackoffMs: number;
};

export type OutboxDrainOutcome = {
  type: 'outbox_drained';
  claimed: number;
  published: number;
  retried: number;
  exhausted: number;
};

export type LifecycleEventsResult<TOutcome> = ApplicationResult<TOutcome>;
