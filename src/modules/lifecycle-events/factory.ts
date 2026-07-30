import { drainOutbox } from './application/use-cases/drain-outbox';
import type { LifecycleEventsUseCaseDeps } from './application/use-cases/types';

export function createLifecycleEventsUseCases(
  deps: LifecycleEventsUseCaseDeps
) {
  return {
    drain: () => drainOutbox(deps),
  };
}

export type LifecycleEventsUseCases = ReturnType<
  typeof createLifecycleEventsUseCases
>;
