import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';
import { z } from 'zod';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { ConfigurationError } from '@/modules/kernel/domain/errors/configuration-error';
import {
  getRedisConfig,
  type RedisConfig,
} from '@/modules/kernel/infrastructure/config/redis';
import { assertUrlHasNoCredentials } from '@/modules/kernel/infrastructure/config/url-security';
import type { TelemetryAdapter } from '@/platform/telemetry';

import type { SecondaryStore } from '../../application/ports/secondary-store';

const upstashError = (message: string, cause?: unknown) =>
  new AppError({
    code: 'AUTH_SECONDARY_STORE_UPSTASH_ERROR',
    category: 'system',
    status: 502,
    message,
    cause,
  });

/**
 * Durable {@link SecondaryStore} backed by Upstash Redis over its REST API.
 *
 * Commands are issued in array form (`POST <restUrl>` with a
 * `["SET", key, value, "EX", ttl]` / `["GET", key]` / `["DEL", key]` body and
 * `Authorization: Bearer <restToken>`), and the `{ result }` envelope is parsed
 * back out. Transport failures are returned as Result errors and reported to
 * telemetry; security-sensitive rate limiting fails closed at its adapter.
 */

type UpstashCommand = (string | number)[];
type CommandOutcome = BoxedResult<unknown, AppError>;

const DEFAULT_TIMEOUT_MS = 2_000;
const rateLimitConsumeResponseSchema = z.union([
  z.tuple([z.literal(1), z.literal(-1)]),
  z.tuple([z.literal(0), z.number().int().positive()]),
]);
const TAKE_IF_MATCHES_SCRIPT = `
local value = redis.call("GET", KEYS[1])
if value == ARGV[1] then
  redis.call("DEL", KEYS[1])
  return value
end
return nil
`;
const CONSUME_RATE_LIMIT_SCRIPT = `
local current = redis.call("GET", KEYS[1])
local timestamp = redis.call("TIME")
local now = tonumber(timestamp[1]) * 1000 + math.floor(tonumber(timestamp[2]) / 1000)
local max = tonumber(ARGV[1])
local window = tonumber(ARGV[2])

if current then
  local ok, data = pcall(cjson.decode, current)
  local ttl = redis.call("TTL", KEYS[1])
  if not ok or type(data) ~= "table" or type(data.count) ~= "number" or data.count < 0 or data.count % 1 ~= 0 then
    return redis.error_reply("invalid rate-limit state")
  end
  if ttl > 0 then
    if data.count >= max then
      return {0, ttl}
    end
    data.count = data.count + 1
    data.lastRequest = now
    redis.call("SET", KEYS[1], cjson.encode(data), "KEEPTTL")
    return {1, -1}
  end
end

redis.call("SET", KEYS[1], cjson.encode({key = KEYS[1], count = 1, lastRequest = now}), "EX", window)
return {1, -1}
`;

export type UpstashSecondaryStoreOptions = {
  /** Injected telemetry sink used to report best-effort transport failures. */
  telemetry: Pick<TelemetryAdapter, 'captureException'>;
  config?: RedisConfig;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

export class UpstashSecondaryStore implements SecondaryStore {
  private readonly restUrl: string;
  private readonly restToken: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly telemetry: Pick<TelemetryAdapter, 'captureException'>;

  constructor(options: UpstashSecondaryStoreOptions) {
    const config = options.config ?? getRedisConfig();
    if (!config) {
      throw new ConfigurationError(
        'UpstashSecondaryStore requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.'
      );
    }
    assertUrlHasNoCredentials({
      name: 'UPSTASH_REDIS_REST_URL',
      value: config.restUrl,
    });
    this.restUrl = config.restUrl;
    this.restToken = config.restToken;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.telemetry = options.telemetry;
  }

  private reportFailure(operation: string, error: unknown): void {
    this.telemetry.captureException(error, {
      level: 'warning',
      tags: { 'auth.secondary_store': 'upstash', 'auth.operation': operation },
    });
  }

  private invalidResponse(operation: string, cause?: unknown) {
    const error = upstashError(
      `Upstash returned an invalid ${operation} response`,
      cause
    );
    this.reportFailure(operation, error);
    return error;
  }

  private invalidTtlError(ttlSeconds: number) {
    return new AppError({
      code: 'AUTH_SECONDARY_STORE_INVALID_TTL',
      category: 'system',
      status: 500,
      message: 'Secondary store ttlSeconds must be a finite positive number.',
      details: { ttlSeconds },
    });
  }

  private async command(args: UpstashCommand): Promise<CommandOutcome> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(this.restUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.restToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      if (!response.ok) {
        return Result.Error(
          upstashError(`Upstash request failed with status ${response.status}`)
        );
      }
      const body = (await response.json()) as {
        result?: unknown;
        error?: string;
      };
      if (typeof body !== 'object' || body === null) {
        return Result.Error(
          upstashError('Upstash returned an invalid envelope')
        );
      }
      if (typeof body.error === 'string') {
        return Result.Error(upstashError(body.error));
      }
      if (!Object.hasOwn(body, 'result')) {
        return Result.Error(
          upstashError('Upstash returned an invalid envelope')
        );
      }
      return Result.Ok(body.result);
    } catch (error) {
      return Result.Error(upstashError('Upstash request failed', error));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async get(key: string): ReturnType<SecondaryStore['get']> {
    const outcome = await this.command(['GET', key]);
    if (outcome.isError()) {
      this.reportFailure('get', outcome.getError());
      return Result.Error(outcome.getError());
    }
    const value = outcome.get();
    if (value === null) {
      return Result.Ok({ type: 'secondary_store_miss' });
    }
    if (typeof value !== 'string') {
      return Result.Error(this.invalidResponse('get'));
    }
    return Result.Ok({ type: 'secondary_store_hit', value });
  }

  async set(
    key: string,
    value: string,
    ttlSeconds?: number
  ): ReturnType<SecondaryStore['set']> {
    if (
      ttlSeconds !== undefined &&
      (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0)
    ) {
      return Result.Error(this.invalidTtlError(ttlSeconds));
    }

    const args: UpstashCommand =
      ttlSeconds !== undefined
        ? ['SET', key, value, 'EX', ttlSeconds]
        : ['SET', key, value];
    const outcome = await this.command(args);
    if (outcome.isError()) {
      this.reportFailure('set', outcome.getError());
      return Result.Error(outcome.getError());
    }
    if (outcome.get() !== 'OK') {
      return Result.Error(this.invalidResponse('set'));
    }
    return Result.Ok({ type: 'secondary_store_set' });
  }

  async take(
    key: string,
    expectedValue: string
  ): ReturnType<SecondaryStore['take']> {
    const outcome = await this.command([
      'EVAL',
      TAKE_IF_MATCHES_SCRIPT,
      1,
      key,
      expectedValue,
    ]);
    if (outcome.isError()) {
      this.reportFailure('take', outcome.getError());
      return Result.Error(outcome.getError());
    }
    const value = outcome.get();
    if (value === null) {
      return Result.Ok({ type: 'secondary_store_miss' });
    }
    if (value !== expectedValue) {
      return Result.Error(this.invalidResponse('take'));
    }
    return Result.Ok({ type: 'secondary_store_taken', value });
  }

  async delete(key: string): ReturnType<SecondaryStore['delete']> {
    const outcome = await this.command(['DEL', key]);
    if (outcome.isError()) {
      this.reportFailure('delete', outcome.getError());
      return Result.Error(outcome.getError());
    }
    const deleted = outcome.get();
    if (
      typeof deleted !== 'number' ||
      !Number.isSafeInteger(deleted) ||
      (deleted !== 0 && deleted !== 1)
    ) {
      return Result.Error(this.invalidResponse('delete'));
    }
    return Result.Ok({ type: 'secondary_store_deleted' });
  }

  async consumeRateLimit(
    key: string,
    rule: { max: number; window: number }
  ): ReturnType<SecondaryStore['consumeRateLimit']> {
    const outcome = await this.command([
      'EVAL',
      CONSUME_RATE_LIMIT_SCRIPT,
      1,
      key,
      rule.max,
      rule.window,
    ]);
    if (outcome.isError()) {
      this.reportFailure('consume_rate_limit', outcome.getError());
      return Result.Error(outcome.getError());
    }
    const value = rateLimitConsumeResponseSchema.safeParse(outcome.get());
    if (!value.success) {
      const error = upstashError('Upstash returned invalid rate-limit state');
      this.reportFailure('consume_rate_limit', error);
      return Result.Error(error);
    }
    const [allowed, retryAfter] = value.data;
    return Result.Ok({
      type: 'secondary_store_rate_limit_consumed',
      allowed: allowed === 1,
      retryAfter: retryAfter === -1 ? null : Math.min(retryAfter, rule.window),
    });
  }
}
