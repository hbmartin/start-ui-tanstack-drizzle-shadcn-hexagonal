import { Option } from '@bloodyowl/boxed';

import type { CacheGateway } from '@/modules/kernel/application/ports/cache-gateway';
import type { Clock } from '@/modules/kernel/application/ports/clock';
import type { IdGenerator } from '@/modules/kernel/application/ports/id-generator';
import type { Logger } from '@/modules/kernel/application/ports/logger';
import { systemClock } from '@/modules/kernel/infrastructure/clock/system-clock';
import { cuidIdGenerator } from '@/modules/kernel/infrastructure/id/nanoid';
import { createTelemetryLogger } from '@/modules/kernel/infrastructure/logger/telemetry';
import type { TelemetryAdapter } from '@/platform/telemetry';

import { createCachedFactory } from './shared/singleton';
import type { Overrides } from './shared/types';
import { telemetryProxy } from './telemetry';

type CacheEntry = {
  value: unknown;
  expiresAt?: number;
};

const memoryCache = (clock: Clock): CacheGateway => {
  const entries = new Map<string, CacheEntry>();
  return {
    async get<T>(key: string) {
      const entry = entries.get(key);
      if (!entry) return Option.None<T>();
      if (
        entry.expiresAt !== undefined &&
        entry.expiresAt <= clock.now().getTime()
      ) {
        entries.delete(key);
        return Option.None<T>();
      }
      return Option.Some(entry.value as T);
    },
    async set<T>(key: string, value: T, options?: { ttlMs?: number }) {
      entries.set(key, {
        value,
        expiresAt:
          options?.ttlMs === undefined
            ? undefined
            : clock.now().getTime() + options.ttlMs,
      });
    },
    async delete(key: string) {
      entries.delete(key);
    },
  };
};

const createProductionLogger = (): Logger =>
  createTelemetryLogger({ telemetry: telemetryProxy });

export type Kernel = {
  logger: Logger;
  telemetry: TelemetryAdapter;
  clock: Clock;
  idGenerator: IdGenerator;
  cacheGateway: CacheGateway;
};

export type KernelOverrides = Overrides<Kernel>;

const buildDefaultKernel = (): Kernel => {
  const clock = systemClock;
  return {
    logger: createProductionLogger(),
    telemetry: telemetryProxy,
    clock,
    idGenerator: cuidIdGenerator,
    cacheGateway: memoryCache(clock),
  };
};

const factory = createCachedFactory<Kernel, KernelOverrides>(
  buildDefaultKernel
);

export const getKernel = (overrides?: KernelOverrides): Kernel => {
  if (overrides === undefined) return factory.get();

  const base = factory.get();
  const clock = overrides.clock ?? base.clock;
  return {
    logger: overrides.logger ?? base.logger,
    telemetry: overrides.telemetry ?? base.telemetry,
    clock,
    idGenerator: overrides.idGenerator ?? base.idGenerator,
    cacheGateway:
      overrides.cacheGateway ??
      (overrides.clock !== undefined ? memoryCache(clock) : base.cacheGateway),
  };
};

/** Test-only. */
export const __resetKernelComposition = () => factory.reset();
