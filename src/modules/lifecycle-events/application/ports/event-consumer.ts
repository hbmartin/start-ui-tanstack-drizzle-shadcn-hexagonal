import type { ApplicationResult, OutboxEventRecord } from '@/modules/kernel';

export type LifecycleEventConsumeOutcome = { type: 'lifecycle_event_consumed' };

/**
 * A side-effect subscriber for drained outbox events. Delivery is
 * at-least-once: consumers must tolerate replays (dedupe on the event id when
 * the side effect is not idempotent).
 */
export interface LifecycleEventConsumer {
  /** Stable identifier used in logs and failure records. */
  name: string;
  handles(eventType: string): boolean;
  consume(
    event: OutboxEventRecord
  ): Promise<ApplicationResult<LifecycleEventConsumeOutcome>>;
}
