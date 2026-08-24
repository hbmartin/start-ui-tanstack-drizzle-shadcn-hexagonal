import { Result } from '@bloodyowl/boxed';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toAuditSubjectId, type AuditEventInput } from '@/modules/audit';
import {
  createAuditPort,
  createLoggerAuditFailureSignal,
  type AuditRepository,
} from '@/modules/audit/backend';
import type { IdGenerator, Logger } from '@/modules/kernel';
import {
  AppError,
  toCorrelationId,
  toGeneratedId,
  toUserId,
} from '@/modules/kernel';
import type { ApplicationResult } from '@/modules/kernel/testing';
import { unwrapParseResult } from '@/modules/kernel/testing';

const now = new Date('2026-01-01T00:00:00.000Z');
const correlationId = unwrapParseResult(toCorrelationId('correlation-1'));
const userId = unwrapParseResult(toUserId('user-1'));
const auditId = unwrapParseResult(toGeneratedId('audit-event-1'));
const sessionSubjectId = unwrapParseResult(
  toAuditSubjectId('session', 'session-1')
);
const profileSubjectId = unwrapParseResult(
  toAuditSubjectId('profile', 'profile-1')
);

const requiredEvent = {
  type: 'session.revoked',
  actor: { kind: 'user', userId },
  subject: { kind: 'session', id: sessionSubjectId },
  correlationId,
  metadata: { reason: 'administrator', scope: 'single' },
} as const satisfies AuditEventInput;

const bestEffortEvent = {
  type: 'profile.updated',
  actor: { kind: 'user', userId },
  subject: { kind: 'profile', id: profileSubjectId },
  correlationId,
  metadata: { fields: ['name'] },
} as const satisfies AuditEventInput;

const persistenceError = new AppError({
  code: 'AUDIT_EVENT_PERSISTENCE_FAILED',
  category: 'system',
  status: 500,
});

const makeLogger = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const makeRepository = (): AuditRepository => ({
  append: vi.fn<AuditRepository['append']>(async () =>
    Result.Ok({ type: 'audit_event_persisted' })
  ),
  purgeExpiredBatch: vi.fn<AuditRepository['purgeExpiredBatch']>(async () =>
    Result.Ok({ type: 'audit_events_purged', count: 2, hasMore: false })
  ),
  setLegalHold: vi.fn<AuditRepository['setLegalHold']>(
    async ({ eventId, legalHold }) =>
      Result.Ok({ type: 'audit_legal_hold_updated', eventId, legalHold })
  ),
});

function getOk<TOutcome extends { type: string }>(
  result: ApplicationResult<TOutcome>
) {
  if (result.isError()) throw result.getError();
  return result.get();
}

function getError<TOutcome extends { type: string }>(
  result: ApplicationResult<TOutcome>
) {
  if (result.isOk()) {
    throw new Error(`Expected error, received ${result.get().type}`);
  }
  return result.getError();
}

const createTestPort = (input?: {
  idGenerator?: IdGenerator;
  logger?: Logger;
  repository?: AuditRepository;
}) =>
  createAuditPort({
    clock: { now: () => now },
    failureSignal: createLoggerAuditFailureSignal(
      input?.logger ?? makeLogger()
    ),
    idGenerator: input?.idGenerator ?? {
      createId: () => Result.Ok(auditId),
    },
    repository: input?.repository ?? makeRepository(),
  });

describe('audit port', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('persists a policy-enriched event using injected time and ID', async () => {
    const repository = makeRepository();
    const result = await createTestPort({ repository }).record(requiredEvent);

    expect(getOk(result)).toEqual({
      type: 'audit_recorded',
      eventId: 'audit-event-1',
      occurredAt: now,
    });
    expect(repository.append).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'audit-event-1',
        occurredAt: now,
        persistence: 'required',
        retentionClass: 'security',
        retainUntil: new Date('2027-01-01T00:00:00.000Z'),
      })
    );
  });

  it('fails closed when a required audit event cannot be persisted', async () => {
    const repository = makeRepository();
    vi.mocked(repository.append).mockResolvedValue(
      Result.Error(persistenceError)
    );

    const result = await createTestPort({ repository }).record(requiredEvent);

    expect(getError(result)).toBe(persistenceError);
  });

  it('classifies a low-risk persistence failure and attempts an operational signal', async () => {
    const repository = makeRepository();
    const logger = makeLogger();
    vi.mocked(repository.append).mockResolvedValue(
      Result.Error(persistenceError)
    );

    const result = await createTestPort({ repository, logger }).record(
      bestEffortEvent
    );

    expect(getOk(result)).toEqual({
      type: 'audit_best_effort_failed',
      eventType: 'profile.updated',
      operationalSignalAttempted: true,
    });
    expect(logger.error).toHaveBeenCalledWith({
      event: 'audit.best_effort_recording_failed',
      correlationId,
      error: 'AUDIT_EVENT_PERSISTENCE_FAILED',
      exception: persistenceError,
      details: { auditEventType: 'profile.updated' },
    });
  });

  it('classifies ID failures under the same best-effort policy', async () => {
    const idError = new AppError({
      code: 'ID_SOURCE_FAILED',
      category: 'system',
      status: 500,
    });
    const result = await createTestPort({
      idGenerator: { createId: () => Result.Error(idError) },
    }).record(bestEffortEvent);

    expect(getOk(result)).toEqual({
      type: 'audit_best_effort_failed',
      eventType: 'profile.updated',
      operationalSignalAttempted: true,
    });
  });

  it('isolates a throwing operational logger for best-effort failures', async () => {
    const repository = makeRepository();
    vi.mocked(repository.append).mockResolvedValue(
      Result.Error(persistenceError)
    );
    const logger = makeLogger();
    vi.mocked(logger.error).mockImplementation(() => {
      throw new Error('logger offline');
    });

    const result = await createTestPort({ repository, logger }).record(
      bestEffortEvent
    );

    expect(getOk(result)).toMatchObject({
      type: 'audit_best_effort_failed',
      operationalSignalAttempted: true,
    });
  });
});
