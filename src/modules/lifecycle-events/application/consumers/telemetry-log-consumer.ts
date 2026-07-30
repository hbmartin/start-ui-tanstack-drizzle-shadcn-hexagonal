import { Result } from '@bloodyowl/boxed';

import type { Logger } from '@/modules/kernel';

import type { LifecycleEventConsumer } from '../ports/event-consumer';

/**
 * Demo consumer: emits each drained event to the structured log/telemetry
 * stream. Idempotent by nature, so at-least-once delivery needs no dedupe.
 */
export const createTelemetryLogConsumer = (deps: {
  logger: Pick<Logger, 'info'>;
}): LifecycleEventConsumer => ({
  name: 'telemetry-log',
  handles: () => true,
  async consume(event) {
    deps.logger.info({
      event: 'lifecycle.event_consumed',
      details: {
        consumer: 'telemetry-log',
        outboxEventId: event.id,
        eventType: event.type,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        deployTarget: event.deployTarget,
      },
    });
    return Result.Ok({ type: 'lifecycle_event_consumed' });
  },
});
