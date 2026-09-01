import type { BetterAuthRateLimitStorage, RateLimit } from 'better-auth';
import { z } from 'zod';

import { AppError } from '@/modules/kernel/domain/errors/app-error';

import type { SecondaryStore } from '../../application/ports/secondary-store';

const encoder = new TextEncoder();

export type AtomicBetterAuthRateLimitStorage = BetterAuthRateLimitStorage & {
  consume: NonNullable<BetterAuthRateLimitStorage['consume']>;
};

const invalidRateLimitState = (cause?: unknown) =>
  new AppError({
    code: 'AUTH_RATE_LIMIT_STATE_INVALID',
    category: 'system',
    status: 500,
    message: 'Auth rate-limit state is invalid',
    cause,
  });

const rateLimitSchema = z.object({
  key: z.string(),
  count: z.number().finite(),
  lastRequest: z.number().finite(),
});
const rateLimitRuleSchema = z.object({
  max: z.number().int().positive(),
  window: z.number().int().positive(),
});

const parseRateLimit = (value: string) => {
  try {
    const parsed = rateLimitSchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data satisfies RateLimit;
    throw new TypeError('Invalid Better Auth rate-limit record');
  } catch (cause) {
    throw invalidRateLimitState(cause);
  }
};

const toHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');

export const createBetterAuthRateLimitStorage = (input: {
  defaultWindowSeconds: number;
  hmacSecret: string;
  store: SecondaryStore;
}): AtomicBetterAuthRateLimitStorage => {
  const signingKey = crypto.subtle.importKey(
    'raw',
    encoder.encode(input.hmacSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const storageKey = async (key: string) => {
    const digest = await crypto.subtle.sign(
      'HMAC',
      await signingKey,
      encoder.encode(key)
    );
    return `better-auth:rate-limit:v1:${toHex(digest)}`;
  };

  return {
    async get(key) {
      const result = await input.store.get(await storageKey(key));
      if (result.isError()) throw result.getError();
      const outcome = result.get();
      return outcome.type === 'secondary_store_hit'
        ? parseRateLimit(outcome.value)
        : null;
    },
    async set(key, value) {
      const result = await input.store.set(
        await storageKey(key),
        JSON.stringify(value),
        input.defaultWindowSeconds
      );
      if (result.isError()) throw result.getError();
    },
    async consume(key, rule) {
      const parsedRule = rateLimitRuleSchema.safeParse(rule);
      if (!parsedRule.success) {
        throw invalidRateLimitState(parsedRule.error);
      }
      const result = await input.store.consumeRateLimit(
        await storageKey(key),
        parsedRule.data
      );
      if (result.isError()) throw result.getError();
      const outcome = result.get();
      return {
        allowed: outcome.allowed,
        retryAfter: outcome.retryAfter,
      };
    },
  };
};
