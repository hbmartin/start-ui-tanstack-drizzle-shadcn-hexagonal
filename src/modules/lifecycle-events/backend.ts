import type { Logger, TransactionRunner } from '@/modules/kernel';
import {
  appErrorToResponse,
  createTransactionRunner,
  getDefaultDbClient,
  getDeployTargetConfig,
  getOutboxConfig,
} from '@/modules/kernel/backend';
import { systemClock } from '@/modules/kernel/infrastructure/clock/system-clock';
import { createOutboxRepository } from '@/modules/kernel/infrastructure/db/outbox-repository-drizzle';

import {
  createConsumerRegistry,
  createLifecycleEventsUseCases,
  createTelemetryLogConsumer,
  type LifecycleEventsTransactionContext,
} from './index';
import { createOutboxDrainHandlers } from './transport/http/drain-handler';

/**
 * Wraps a base transaction runner so each transaction exposes an
 * `outboxRepository` bound to that transaction. Shared with
 * `composition/lifecycle-events.ts` (consumed through this public gate); the
 * default base targets the default DB client.
 */
export const createLifecycleEventsTransactionRunner = (
  base: ReturnType<typeof createTransactionRunner> = createTransactionRunner(
    getDefaultDbClient()
  ),
  options?: { deployTarget?: string }
): TransactionRunner<LifecycleEventsTransactionContext> => ({
  run: (work, runOptions) =>
    base.run(
      (tx) =>
        work({
          outboxRepository: createOutboxRepository({
            db: tx,
            deployTarget: options?.deployTarget,
          }),
        }),
      runOptions
    ),
});

/**
 * Telemetry-backed observability is injected by the caller (the HTTP route
 * sources it from `getKernel().logger`). This server gate stays free of the
 * telemetry service-locator and of `@/composition`, which would otherwise
 * form a dependency cycle through `composition/lifecycle-events`.
 */
export type OutboxDrainRequestDeps = {
  logger?: Logger;
};

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const createDefaultLifecycleEventsUseCases = (logger: Logger) => {
  const config = getOutboxConfig();
  return createLifecycleEventsUseCases({
    transactionRunner: createLifecycleEventsTransactionRunner(undefined, {
      deployTarget: getDeployTargetConfig().deployTarget,
    }),
    consumerRegistry: createConsumerRegistry([
      createTelemetryLogConsumer({ logger }),
    ]),
    clock: systemClock,
    logger,
    drainBatchSize: config.drainBatchSize,
    maxAttempts: config.maxAttempts,
    baseBackoffMs: config.baseBackoffMs,
  });
};

export async function handleOutboxDrainRequest(
  request: Request,
  deps: OutboxDrainRequestDeps = {}
) {
  const logger = deps.logger ?? noopLogger;
  try {
    const { drain } = createOutboxDrainHandlers({
      getUseCases: () => createDefaultLifecycleEventsUseCases(logger),
      drainSecret: getOutboxConfig().drainSecret,
      logger,
    });
    return await drain(request);
  } catch (error) {
    return appErrorToResponse(error);
  }
}
