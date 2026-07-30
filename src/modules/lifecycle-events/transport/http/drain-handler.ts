import { Result } from '@bloodyowl/boxed';
import { timingSafeEqual } from 'node:crypto';
import { match, P } from 'ts-pattern';

import type { Logger } from '@/modules/kernel';

import type { LifecycleEventsUseCases } from '../../factory';

type OutboxDrainHandlerDeps = {
  getUseCases: () => Pick<LifecycleEventsUseCases, 'drain'>;
  /** Bearer secret required to drain; requests are rejected when unset. */
  drainSecret?: string;
  logger?: Pick<Logger, 'warn'>;
};

const bearerToken = (request: Request) => {
  const header = request.headers.get('Authorization');
  if (!header) return undefined;

  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return undefined;

  const token = rest.join(' ').trim();
  return token || undefined;
};

const secretsMatch = (expected: string, provided: string) => {
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  if (expectedBytes.byteLength !== providedBytes.byteLength) return false;
  return timingSafeEqual(expectedBytes, providedBytes);
};

export const createOutboxDrainHandlers = ({
  getUseCases,
  drainSecret,
  logger,
}: OutboxDrainHandlerDeps) => {
  const drain = async (request: Request) => {
    if (!drainSecret) {
      logger?.warn({
        event: 'security.outbox_drain_unconfigured',
        details: { reason: 'OUTBOX_DRAIN_SECRET is not set' },
      });
      return Response.json(
        { ok: false, error: 'drain_not_configured' },
        { status: 503 }
      );
    }

    const token = bearerToken(request);
    if (!token || !secretsMatch(drainSecret, token)) {
      logger?.warn({
        event: 'security.outbox_drain_unauthorized',
        details: { reason: token ? 'invalid_secret' : 'missing_bearer_token' },
      });
      return Response.json(
        { ok: false, error: 'unauthorized' },
        { status: 401 }
      );
    }

    const result = await getUseCases().drain();

    return match(result)
      .with(Result.P.Error(P.select()), (error) => {
        throw error;
      })
      .with(
        Result.P.Ok(P.select({ type: 'outbox_drained' })),
        ({ claimed, published, retried, exhausted }) =>
          Response.json({ ok: true, claimed, published, retried, exhausted })
      )
      .exhaustive();
  };

  return { drain };
};

export type OutboxDrainHandlers = ReturnType<typeof createOutboxDrainHandlers>;
