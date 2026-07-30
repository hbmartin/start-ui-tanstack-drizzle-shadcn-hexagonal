import type { LifecycleEventConsumer } from '../ports/event-consumer';

export type ConsumerRegistry = {
  consumersFor(eventType: string): LifecycleEventConsumer[];
};

export const createConsumerRegistry = (
  consumers: LifecycleEventConsumer[]
): ConsumerRegistry => ({
  consumersFor: (eventType) =>
    consumers.filter((consumer) => consumer.handles(eventType)),
});
