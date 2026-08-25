import { z } from 'zod';

import type { BetterAuthConfig } from '@/modules/kernel/infrastructure/config/auth';

import { TRUSTED_AUTH_CLIENT_IP_HEADER } from './auth-http-exposure';

type AtomicRateLimitStorage = {
  consume(
    key: string,
    rule: { max: number; window: number }
  ): Promise<{ allowed: boolean; retryAfter: number | null }>;
};

const identityBodySchema = z
  .object({ email: z.email().transform((value) => value.toLowerCase()) })
  .passthrough();

const readIdentity = async (request: Request) => {
  if (request.method !== 'POST') return undefined;
  try {
    const parsed = identityBodySchema.safeParse(await request.clone().json());
    return parsed.success ? parsed.data.email : undefined;
  } catch {
    return undefined;
  }
};

const limitedResponse = (retryAfter: number, maximum: number) => {
  const boundedRetryAfter = Math.min(maximum, Math.max(1, retryAfter));
  return Response.json(
    { message: 'Too many requests. Please try again later.' },
    {
      headers: {
        'Retry-After': String(boundedRetryAfter),
        'X-Retry-After': String(boundedRetryAfter),
      },
      status: 429,
      statusText: 'Too Many Requests',
    }
  );
};

const consumeRule = async (
  storage: AtomicRateLimitStorage,
  key: string,
  rule: { max: number; window: number }
) => {
  const outcome = await storage.consume(key, rule);
  return outcome.allowed
    ? undefined
    : limitedResponse(outcome.retryAfter ?? rule.window, rule.window);
};

const getIdentityRule = (request: Request, config: BetterAuthConfig) => {
  const pathname = new URL(request.url).pathname;
  return pathname.endsWith('/email-otp/send-verification-otp')
    ? {
        max: config.otpSendMax,
        window: config.otpSendWindowSeconds,
      }
    : {
        max: config.rateLimitMax,
        window: config.rateLimitWindowSeconds,
      };
};

export const createAuthHttpRateLimiter = (input: {
  config: BetterAuthConfig;
  storage: AtomicRateLimitStorage;
}) => ({
  async check(request: Request): Promise<Response | undefined> {
    const pathname = new URL(request.url).pathname;
    const network = request.headers.get(TRUSTED_AUTH_CLIENT_IP_HEADER);
    const commonRule = {
      max: input.config.rateLimitMax,
      window: input.config.rateLimitWindowSeconds,
    };
    const globalLimit = await consumeRule(input.storage, 'auth-http:global', {
      ...commonRule,
      max: Math.min(Number.MAX_SAFE_INTEGER, commonRule.max * 100),
    });
    if (globalLimit) return globalLimit;

    if (network) {
      const networkLimit = await consumeRule(
        input.storage,
        `auth-http:network:${network}:${pathname}`,
        commonRule
      );
      if (networkLimit) return networkLimit;
    }

    const identity = await readIdentity(request);
    if (!identity) return undefined;
    return consumeRule(
      input.storage,
      `auth-http:identity:${identity}:${pathname}`,
      getIdentityRule(request, input.config)
    );
  },
});
