import { createPgliteTestDatabase } from '@tests/server/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  toAuditEventId,
  toAuditSubjectId,
  type AuditEventInput,
} from '@/modules/audit';
import {
  createAuditPort,
  createAuditRepository,
  createLoggerAuditFailureSignal,
  type AuditEventRecord,
} from '@/modules/audit/backend';
import { auditEvent as auditEventTable } from '@/modules/audit/persistence';
import { toCorrelationId, toGeneratedId, toUserId } from '@/modules/kernel';
import type { ApplicationResult } from '@/modules/kernel/testing';
import { unwrapParseResult } from '@/modules/kernel/testing';

const now = new Date('2026-01-01T00:00:00.000Z');
const historicalOccurrence = new Date('2024-01-01T00:00:00.000Z');
const correlationId = unwrapParseResult(toCorrelationId('correlation-1'));
const userId = unwrapParseResult(toUserId('user-1'));

const makeRecord = (input: {
  id: string;
  legalHold: boolean;
  retainUntil: Date;
}): AuditEventRecord => ({
  id: unwrapParseResult(
    toAuditEventId(unwrapParseResult(toGeneratedId(input.id)))
  ),
  type: 'data.book-deleted',
  actor: { kind: 'user', userId },
  subject: {
    kind: 'book',
    id: unwrapParseResult(toAuditSubjectId('book', 'book-1')),
  },
  correlationId,
  metadata: {},
  eventClass: 'data',
  persistence: 'required',
  retentionClass: 'standard',
  occurredAt: historicalOccurrence,
  legalHold: input.legalHold,
  retainUntil: input.retainUntil,
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
  if (result.isOk())
    throw new Error(`Expected error, got ${result.get().type}`);
  return result.getError();
}

const bindDatabaseWithHoldBeforeDelete = (
  database: Awaited<ReturnType<typeof createPgliteTestDatabase>>,
  eventId: string
) =>
  new Proxy(database.db, {
    get(target, property) {
      if (property === 'delete') {
        return (table: typeof auditEventTable) => {
          const deleteBuilder = target.delete(table);
          return {
            where(condition: Parameters<typeof deleteBuilder.where>[0]) {
              const whereBuilder = deleteBuilder.where(condition);
              return {
                async returning(
                  selection: Parameters<typeof whereBuilder.returning>[0]
                ) {
                  await target
                    .update(auditEventTable)
                    .set({ legalHold: true })
                    .where(eq(auditEventTable.id, eventId));
                  return whereBuilder.returning(selection);
                },
              };
            },
          };
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

describe('AuditRepositoryDrizzle integration', () => {
  let database: Awaited<ReturnType<typeof createPgliteTestDatabase>>;

  beforeAll(async () => {
    database = await createPgliteTestDatabase();
  });

  beforeEach(async () => {
    await database.truncate();
  });

  afterAll(async () => {
    await database?.close();
  });

  it('persists the typed event envelope and allowlisted metadata', async () => {
    const repository = createAuditRepository({ db: database.db });
    const event = {
      type: 'authorization.role-changed',
      actor: { kind: 'user', userId },
      subject: {
        kind: 'user',
        id: unwrapParseResult(toAuditSubjectId('user', 'user-2')),
      },
      correlationId,
      metadata: { from: 'user', to: 'admin' },
    } as const satisfies AuditEventInput;
    const port = createAuditPort({
      clock: { now: () => now },
      failureSignal: createLoggerAuditFailureSignal({
        debug() {},
        info() {},
        warn() {},
        error() {},
      }),
      idGenerator: {
        createId: () => toGeneratedId('audit-event-1'),
      },
      repository,
    });

    const result = await port.record(event);
    const rows = await database.db.select().from(auditEventTable);

    expect(getOk(result).type).toBe('audit_recorded');
    expect(rows).toEqual([
      expect.objectContaining({
        id: 'audit-event-1',
        actorKind: 'user',
        actorId: 'user-1',
        subjectKind: 'user',
        subjectId: 'user-2',
        correlationId: 'correlation-1',
        eventClass: 'authorization',
        persistence: 'required',
        metadata: { from: 'user', to: 'admin' },
        legalHold: false,
      }),
    ]);
  });

  it('purges an exact bounded batch and preserves legal holds', async () => {
    const repository = createAuditRepository({ db: database.db });
    const expired = makeRecord({
      id: 'expired',
      legalHold: false,
      retainUntil: new Date('2025-12-31T23:59:59.999Z'),
    });
    const held = makeRecord({
      id: 'held',
      legalHold: true,
      retainUntil: new Date('2025-12-31T23:59:59.999Z'),
    });
    const boundary = makeRecord({
      id: 'boundary',
      legalHold: false,
      retainUntil: now,
    });
    const future = makeRecord({
      id: 'future',
      legalHold: false,
      retainUntil: new Date('2026-01-02T00:00:00.000Z'),
    });
    for (const record of [expired, held, boundary, future]) {
      const result = await repository.append(record);
      expect(result.isOk()).toBe(true);
    }

    const first = await repository.purgeExpiredBatch({ before: now, limit: 1 });
    const second = await repository.purgeExpiredBatch({
      before: now,
      limit: 1,
    });
    const rows = await database.db
      .select({ id: auditEventTable.id })
      .from(auditEventTable);

    expect(getOk(first)).toEqual({
      type: 'audit_events_purged',
      count: 1,
      hasMore: true,
    });
    expect(getOk(second)).toEqual({
      type: 'audit_events_purged',
      count: 1,
      hasMore: false,
    });
    expect(rows.map(({ id }) => id).toSorted()).toEqual(['future', 'held']);
  });

  it('applies and releases a legal hold without discarding its deadline', async () => {
    const repository = createAuditRepository({ db: database.db });
    const record = makeRecord({
      id: 'hold-target',
      legalHold: false,
      retainUntil: new Date('2026-01-02T00:00:00.000Z'),
    });
    expect((await repository.append(record)).isOk()).toBe(true);

    const applied = await repository.setLegalHold({
      eventId: record.id,
      legalHold: true,
    });
    const released = await repository.setLegalHold({
      eventId: record.id,
      legalHold: false,
    });
    const [row] = await database.db.select().from(auditEventTable);

    expect(getOk(applied)).toMatchObject({
      type: 'audit_legal_hold_updated',
      legalHold: true,
    });
    expect(getOk(released)).toMatchObject({
      type: 'audit_legal_hold_updated',
      legalHold: false,
    });
    expect(row?.retainUntil).toEqual(record.retainUntil);
  });

  it('rechecks legal hold eligibility when deleting a selected batch', async () => {
    const record = makeRecord({
      id: 'concurrent-hold',
      legalHold: false,
      retainUntil: now,
    });
    const repository = createAuditRepository({ db: database.db });
    expect((await repository.append(record)).isOk()).toBe(true);
    const racingRepository = createAuditRepository({
      db: bindDatabaseWithHoldBeforeDelete(database, record.id),
    });

    const purged = await racingRepository.purgeExpiredBatch({
      before: now,
      limit: 10,
    });
    const [row] = await database.db.select().from(auditEventTable);

    expect(getOk(purged).count).toBe(0);
    expect(row).toMatchObject({ id: record.id, legalHold: true });
  });

  it('rejects actor/subject and retention corruption at the database boundary', async () => {
    const base = {
      occurredAt: historicalOccurrence,
      type: 'data.book-deleted',
      eventClass: 'data',
      persistence: 'required',
      actorKind: 'user',
      actorId: 'user-1',
      subjectKind: 'book',
      subjectId: 'book-1',
      correlationId: 'correlation-1',
      metadata: {},
      retentionClass: 'standard',
      retainUntil: now,
      legalHold: false,
    } satisfies Omit<typeof auditEventTable.$inferInsert, 'id'>;

    const invalidRows: (typeof auditEventTable.$inferInsert)[] = [
      {
        ...base,
        id: 'anonymous-delete',
        actorKind: 'anonymous',
        actorId: null,
      },
      {
        ...base,
        id: 'null-system-actor',
        type: 'session.revoked',
        eventClass: 'authentication',
        actorKind: 'system',
        actorId: null,
        subjectKind: 'session',
        subjectId: 'session-1',
        metadata: { reason: 'administrator', scope: 'single' },
        retentionClass: 'security',
      },
      {
        ...base,
        id: 'orphan-subject-id',
        subjectKind: null,
      },
      {
        ...base,
        id: 'missing-required-subject',
        subjectKind: null,
        subjectId: null,
      },
      {
        ...base,
        id: 'missing-scope',
        type: 'authentication.signed-out',
        eventClass: 'authentication',
        subjectKind: 'session',
        subjectId: 'session-1',
        metadata: {},
        retentionClass: 'security',
      },
      {
        ...base,
        id: 'contradictory-sign-in',
        type: 'authentication.signed-in',
        eventClass: 'authentication',
        subjectKind: 'user',
        subjectId: 'user-2',
        metadata: { method: 'password' },
        retentionClass: 'security',
      },
      {
        ...base,
        id: 'invalid-retention',
        retainUntil: historicalOccurrence,
      },
    ];

    for (const row of invalidRows) {
      await expect(
        database.db.insert(auditEventTable).values(row)
      ).rejects.toThrow();
    }
  });

  it('maps repository constraint failures to AppError results', async () => {
    const repository = createAuditRepository({ db: database.db });
    const record = makeRecord({
      id: 'duplicate',
      legalHold: false,
      retainUntil: now,
    });
    expect((await repository.append(record)).isOk()).toBe(true);

    const duplicate = await repository.append(record);

    expect(getError(duplicate).code).toBe('AUDIT_EVENT_PERSISTENCE_FAILED');
  });

  it('rejects unsafe purge limits at the repository boundary', async () => {
    const repository = createAuditRepository({ db: database.db });

    const result = await repository.purgeExpiredBatch({
      before: now,
      limit: 0,
    });

    expect(getError(result).code).toBe('AUDIT_RETENTION_PURGE_FAILED');
  });
});
