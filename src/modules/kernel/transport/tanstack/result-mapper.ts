import { Result } from '@bloodyowl/boxed';
import { match, P } from 'ts-pattern';

import type {
  ApplicationResult,
  DomainOutcome,
} from '@/modules/kernel/application/result';
import { AppError } from '@/modules/kernel/domain/errors/app-error';

import {
  ServerFnError,
  type PublicServerErrorReason,
  type PublicServerErrorTarget,
  type ServerFnErrorCode,
} from './server-fn-error';

type ReasonConfig =
  | ServerFnErrorCode
  | {
      code: ServerFnErrorCode;
      reason?: PublicServerErrorReason;
      target?: PublicServerErrorTarget;
    };

const codeForCategory: Record<AppError['category'], ServerFnErrorCode> = {
  bad_request: 'BAD_REQUEST',
  conflict: 'CONFLICT',
  forbidden: 'FORBIDDEN',
  not_found: 'NOT_FOUND',
  rate_limit: 'TOO_MANY_REQUESTS',
  system: 'INTERNAL_SERVER_ERROR',
  unauthorized: 'UNAUTHORIZED',
};

const publicErrorForAppCode: Readonly<
  Record<
    string,
    Readonly<{
      reason: PublicServerErrorReason;
      target: PublicServerErrorTarget;
    }>
  >
> = {
  BOOK_DUPLICATE: { reason: 'already_exists', target: 'book.title' },
  GENRE_DUPLICATE: { reason: 'already_exists', target: 'genre' },
  USER_DUPLICATE: { reason: 'already_exists', target: 'user.email' },
};

const throwServerFnErrorForReason = (
  reason: string,
  reasons: Record<string, ReasonConfig>
): never => {
  const config = reasons[reason];
  if (!config) {
    throw new ServerFnError('INTERNAL_SERVER_ERROR');
  }
  if (typeof config === 'string') {
    throw new ServerFnError(config);
  }
  throw new ServerFnError(config.code, {
    reason: config.reason,
    target: config.target,
  });
};

const mapAppErrorToServerFnError = (error: unknown): never => {
  if (error instanceof AppError) {
    const isInternal = error.category === 'system' || error.status >= 500;
    const publicOverride = isInternal
      ? undefined
      : publicErrorForAppCode[error.code];
    throw new ServerFnError(
      isInternal ? 'INTERNAL_SERVER_ERROR' : codeForCategory[error.category],
      {
        cause: error,
        reason: publicOverride?.reason,
        target: publicOverride?.target,
      }
    );
  }
  throw error;
};

type OutcomeHandler<TOutcome extends DomainOutcome, TResult> =
  | ReasonConfig
  | ((outcome: TOutcome) => TResult);

export type OutcomeHandlerConfig<TOutcome extends DomainOutcome, TResult> = {
  [TType in TOutcome['type']]: OutcomeHandler<
    Extract<TOutcome, { type: TType }>,
    TResult
  >;
};

type OutcomeHandlerReturn<THandlers> = {
  [TKey in keyof THandlers]: THandlers[TKey] extends (
    outcome: ExplicitAny
  ) => infer TResult
    ? TResult
    : never;
}[keyof THandlers];

export async function unwrapApplicationResult<
  TOutcome extends DomainOutcome,
  THandlers extends OutcomeHandlerConfig<TOutcome, unknown>,
>(
  result: Promise<ApplicationResult<TOutcome>> | ApplicationResult<TOutcome>,
  handlers: THandlers
): Promise<OutcomeHandlerReturn<THandlers>> {
  const value = await Promise.resolve(result).catch(mapAppErrorToServerFnError);

  return match(value)
    .with(Result.P.Ok(P.select()), (outcome) => {
      const typedOutcome = outcome as unknown as TOutcome;
      const outcomeType = typedOutcome.type as TOutcome['type'];
      const handler = handlers[outcomeType];
      if (typeof handler === 'function') {
        return (
          handler as (outcome: TOutcome) => OutcomeHandlerReturn<THandlers>
        )(typedOutcome);
      }
      return throwServerFnErrorForReason(outcomeType, {
        [outcomeType]: handler,
      });
    })
    .with(Result.P.Error(P.select()), (error) =>
      mapAppErrorToServerFnError(error)
    )
    .exhaustive();
}
