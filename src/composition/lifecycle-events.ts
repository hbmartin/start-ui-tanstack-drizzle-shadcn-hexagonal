import type { OutboxRepository, TransactionRunner } from '@/modules/kernel';
import { getOutboxConfig } from '@/modules/kernel/backend';
import {
  createConsumerRegistry,
  createLifecycleEventsUseCases,
  createTelemetryLogConsumer,
  type LifecycleEventConsumer,
  type LifecycleEventsTransactionContext,
} from '@/modules/lifecycle-events';
import { createLifecycleEventsTransactionRunner } from '@/modules/lifecycle-events/backend';

import { getKernel, type Kernel } from './kernel';
import { createCachedFactory } from './shared/singleton';

export type LifecycleEventsOverrides = {
  kernel?: Kernel;
  outboxRepository?: OutboxRepository;
  consumers?: LifecycleEventConsumer[];
};

const createTransactionRunnerForOverrides = (
  kernel: Kernel,
  outboxRepositoryOverride?: OutboxRepository
): TransactionRunner<LifecycleEventsTransactionContext> => {
  if (outboxRepositoryOverride) {
    return {
      run: (work) => work({ outboxRepository: outboxRepositoryOverride }),
    };
  }

  return createLifecycleEventsTransactionRunner(kernel.transactionRunner, {
    deployTarget: kernel.deployTarget,
  });
};

const buildLifecycleEventsUseCases = (overrides?: LifecycleEventsOverrides) => {
  const kernel = overrides?.kernel ?? getKernel();
  const config = getOutboxConfig();

  return createLifecycleEventsUseCases({
    transactionRunner: createTransactionRunnerForOverrides(
      kernel,
      overrides?.outboxRepository
    ),
    consumerRegistry: createConsumerRegistry(
      overrides?.consumers ?? [
        createTelemetryLogConsumer({ logger: kernel.logger }),
      ]
    ),
    clock: kernel.clock,
    logger: kernel.logger,
    drainBatchSize: config.drainBatchSize,
    maxAttempts: config.maxAttempts,
    baseBackoffMs: config.baseBackoffMs,
  });
};

const factory = createCachedFactory(buildLifecycleEventsUseCases);

export const getLifecycleEventsUseCases = (
  overrides?: LifecycleEventsOverrides
) => factory.get(overrides);

/** Test-only. */
export const __resetLifecycleEventsComposition = () => factory.reset();
