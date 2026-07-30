import type { ApplicationResult } from '../result';
import type { OutboxEventId } from '../../domain/ids';

/**
 * Transactional outbox port. Emitting modules append envelopes inside the
 * same transaction as their state change (via their module-bound transaction
 * context); the lifecycle-events drain claims pending rows with
 * `FOR UPDATE SKIP LOCKED` and delivers them to consumers at-least-once.
 */
export type OutboxEventEnvelope = {
  /** Event type, e.g. `book.created`. */
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  /**
   * Optional idempotency key: recording a second envelope with the same key
   * is a no-op (`outbox_event_deduplicated`).
   */
  dedupeKey?: string;
};

export type OutboxEventStatus = 'pending' | 'published' | 'failed';

export type OutboxEventRecord = {
  id: OutboxEventId;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  /** Deploy target the envelope was recorded from (see `checkDeployTarget`). */
  deployTarget: string | null;
  status: OutboxEventStatus;
  attempts: number;
  availableAt: Date;
  publishedAt: Date | null;
  lastError: string | null;
  dedupeKey: string | null;
  createdAt: Date;
};

export type OutboxRecordOutcome =
  | { type: 'outbox_event_recorded'; record: OutboxEventRecord }
  | { type: 'outbox_event_deduplicated' };

export type OutboxClaimBatchOutcome = {
  type: 'outbox_batch_claimed';
  records: OutboxEventRecord[];
};

export type OutboxMarkPublishedOutcome = { type: 'outbox_event_published' };

export type OutboxMarkFailedOutcome = {
  type: 'outbox_event_failure_recorded';
};

export interface OutboxRepository {
  record(
    envelope: OutboxEventEnvelope
  ): Promise<ApplicationResult<OutboxRecordOutcome>>;
  /**
   * Locks and returns due pending events, skipping rows already locked by a
   * concurrent drain. Must be called inside a transaction so the row locks
   * are held until the caller marks each event published or failed.
   */
  claimBatch(input: {
    limit: number;
    now: Date;
  }): Promise<ApplicationResult<OutboxClaimBatchOutcome>>;
  markPublished(input: {
    id: OutboxEventId;
    publishedAt: Date;
  }): Promise<ApplicationResult<OutboxMarkPublishedOutcome>>;
  /**
   * Records a delivery failure. A `nextAttemptAt` reschedules the event;
   * `null` marks it terminally failed (retries exhausted).
   */
  markFailed(input: {
    id: OutboxEventId;
    error: string;
    nextAttemptAt: Date | null;
  }): Promise<ApplicationResult<OutboxMarkFailedOutcome>>;
}
