import { Result } from '@bloodyowl/boxed';
import { and, asc, eq, inArray, isNotNull, lte } from 'drizzle-orm';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import type { ApplicationResult } from '@/modules/kernel/application/result';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';

import type {
  AuditEventPersisted,
  AuditEventNotFound,
  AuditEventsPurged,
  AuditLegalHoldUpdated,
  AuditRepository,
} from '../../application/ports/audit-repository';
import type { AuditEventRecord } from '../../domain/audit-event';
import { isValidAuditPurgeBatchSize } from '../../domain/audit-retention';
import { auditEvent as auditEventTable } from './schema';

const auditPersistenceError = (
  operation: 'append' | 'hold' | 'purge',
  cause: unknown
) =>
  new AppError({
    code:
      operation === 'append'
        ? 'AUDIT_EVENT_PERSISTENCE_FAILED'
        : operation === 'hold'
          ? 'AUDIT_LEGAL_HOLD_UPDATE_FAILED'
          : 'AUDIT_RETENTION_PURGE_FAILED',
    category: 'system',
    status: 500,
    message:
      operation === 'append'
        ? 'Audit event persistence failed'
        : operation === 'hold'
          ? 'Audit legal hold update failed'
          : 'Audit retention purge failed',
    cause,
  });

export class AuditRepositoryDrizzle implements AuditRepository {
  constructor(private readonly db: DbLike) {}

  async append(
    record: AuditEventRecord
  ): Promise<ApplicationResult<AuditEventPersisted>> {
    try {
      const actorId =
        record.actor.kind === 'user'
          ? record.actor.userId
          : record.actor.kind === 'system'
            ? record.actor.name
            : null;
      const values = {
        id: record.id,
        occurredAt: record.occurredAt,
        type: record.type,
        eventClass: record.eventClass,
        persistence: record.persistence,
        actorKind: record.actor.kind,
        actorId,
        subjectKind: record.subject?.kind ?? null,
        subjectId: record.subject?.id ?? null,
        correlationId: record.correlationId,
        metadata: record.metadata,
        retentionClass: record.retentionClass,
        retainUntil: record.retainUntil,
        legalHold: record.legalHold,
      } satisfies typeof auditEventTable.$inferInsert;
      await this.db.insert(auditEventTable).values(values);
      return Result.Ok({ type: 'audit_event_persisted' });
    } catch (error) {
      return Result.Error(auditPersistenceError('append', error));
    }
  }

  async purgeExpiredBatch(input: {
    before: Date;
    limit: number;
  }): Promise<ApplicationResult<AuditEventsPurged>> {
    try {
      if (!isValidAuditPurgeBatchSize(input.limit)) {
        return Result.Error(
          auditPersistenceError(
            'purge',
            new RangeError('Audit purge batch size is outside the safe range')
          )
        );
      }
      const candidates = await this.db
        .select({ id: auditEventTable.id })
        .from(auditEventTable)
        .where(
          and(
            eq(auditEventTable.legalHold, false),
            isNotNull(auditEventTable.retainUntil),
            lte(auditEventTable.retainUntil, input.before)
          )
        )
        .orderBy(asc(auditEventTable.retainUntil), asc(auditEventTable.id))
        .limit(input.limit + 1);
      const ids = candidates.slice(0, input.limit).map(({ id }) => id);
      if (ids.length === 0) {
        return Result.Ok({
          type: 'audit_events_purged',
          count: 0,
          hasMore: false,
        });
      }
      const deleted = await this.db
        .delete(auditEventTable)
        .where(
          and(
            inArray(auditEventTable.id, ids),
            eq(auditEventTable.legalHold, false),
            isNotNull(auditEventTable.retainUntil),
            lte(auditEventTable.retainUntil, input.before)
          )
        )
        .returning({ id: auditEventTable.id });
      return Result.Ok({
        type: 'audit_events_purged',
        count: deleted.length,
        hasMore: candidates.length > input.limit,
      });
    } catch (error) {
      return Result.Error(auditPersistenceError('purge', error));
    }
  }

  async setLegalHold(input: {
    eventId: AuditEventRecord['id'];
    legalHold: boolean;
  }): Promise<ApplicationResult<AuditEventNotFound | AuditLegalHoldUpdated>> {
    try {
      const updated = await this.db
        .update(auditEventTable)
        .set({ legalHold: input.legalHold })
        .where(eq(auditEventTable.id, input.eventId))
        .returning({ id: auditEventTable.id });
      return updated.length === 0
        ? Result.Ok({ type: 'audit_event_not_found', eventId: input.eventId })
        : Result.Ok({
            type: 'audit_legal_hold_updated',
            eventId: input.eventId,
            legalHold: input.legalHold,
          });
    } catch (error) {
      return Result.Error(auditPersistenceError('hold', error));
    }
  }
}

export const createAuditRepository = (input: { db: DbLike }) =>
  new AuditRepositoryDrizzle(input.db);
