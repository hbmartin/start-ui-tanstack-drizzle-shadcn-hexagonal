export {
  type ConsumerRegistry,
  createConsumerRegistry,
} from './application/consumers/consumer-registry';
export { createTelemetryLogConsumer } from './application/consumers/telemetry-log-consumer';
export type * from './application/ports/event-consumer';
export type {
  LifecycleEventsResult,
  LifecycleEventsTransactionContext,
  LifecycleEventsUseCaseDeps,
  OutboxDrainOutcome,
} from './application/use-cases/types';
export * from './domain/domain-event';
export {
  createLifecycleEventsUseCases,
  type LifecycleEventsUseCases,
} from './factory';
