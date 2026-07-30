import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { z } from 'zod';

import type {
  OutboxEventRecord,
  OutboxEventStatus,
  OutboxRepository,
} from '@/modules/kernel/application/ports/outbox-repository';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { toOutboxEventId } from '@/modules/kernel/domain/ids';
import { observeRepository } from '@/modules/kernel/infrastructure/db/observability';
import {
  outbox as outboxTable,
  type OutboxEvent,
} from '@/modules/kernel/infrastructure/db/schema';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';

const outboxStatusSchema = z.enum(['pending', 'published', 'failed']);
const outboxPayloadSchema = z.record(z.string(), z.unknown());

function invalidOutboxRowError(cause: unknown): AppError {
  return new AppError({
    code: 'OUTBOX_ROW_INVALID',
    category: 'system',
    status: 500,
    message: 'Outbox row contains invalid data',
    cause,
  });
}

function mapDbError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError({
    code: 'OUTBOX_REPOSITORY_ERROR',
    category: 'system',
    status: 500,
    message: 'Outbox repository error',
    cause: error,
  });
}

const toDomain = (
  row: OutboxEvent
): BoxedResult<OutboxEventRecord, AppError> => {
  const id = toOutboxEventId(row.id);
  if (id.isError()) return Result.Error(invalidOutboxRowError(id.getError()));

  const status = outboxStatusSchema.safeParse(row.status);
  if (!status.success) {
    return Result.Error(invalidOutboxRowError(status.error));
  }

  const payload = outboxPayloadSchema.safeParse(row.payload);
  if (!payload.success) {
    return Result.Error(invalidOutboxRowError(payload.error));
  }

  return Result.Ok({
    id: id.get(),
    type: row.type,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    payload: payload.data,
    deployTarget: row.deployTarget,
    status: status.data satisfies OutboxEventStatus,
    attempts: row.attempts,
    availableAt: row.availableAt,
    publishedAt: row.publishedAt,
    lastError: row.lastError,
    dedupeKey: row.dedupeKey,
    createdAt: row.createdAt,
  });
};

export class OutboxRepositoryDrizzle implements OutboxRepository {
  constructor(
    private readonly db: DbLike,
    private readonly deployTarget?: string
  ) {}

  async record(
    envelope: Parameters<OutboxRepository['record']>[0]
  ): ReturnType<OutboxRepository['record']> {
    try {
      const [created] = await this.db
        .insert(outboxTable)
        .values({
          type: envelope.type,
          aggregateType: envelope.aggregateType,
          aggregateId: envelope.aggregateId,
          payload: envelope.payload,
          deployTarget: this.deployTarget ?? null,
          dedupeKey: envelope.dedupeKey ?? null,
        })
        .onConflictDoNothing({
          target: [outboxTable.dedupeKey],
          where: sql`${outboxTable.dedupeKey} is not null`,
        })
        .returning();

      if (!created) {
        return Result.Ok({ type: 'outbox_event_deduplicated' });
      }

      const record = toDomain(created);
      if (record.isError()) return Result.Error(record.getError());

      return Result.Ok({ type: 'outbox_event_recorded', record: record.get() });
    } catch (error) {
      return Result.Error(mapDbError(error));
    }
  }

  async claimBatch(
    input: Parameters<OutboxRepository['claimBatch']>[0]
  ): ReturnType<OutboxRepository['claimBatch']> {
    try {
      const rows = await this.db
        .select()
        .from(outboxTable)
        .where(
          and(
            eq(outboxTable.status, 'pending'),
            lte(outboxTable.availableAt, input.now)
          )
        )
        .orderBy(asc(outboxTable.availableAt), asc(outboxTable.id))
        .limit(input.limit)
        .for('update', { skipLocked: true });

      const records: OutboxEventRecord[] = [];
      for (const row of rows) {
        const record = toDomain(row);
        if (record.isError()) return Result.Error(record.getError());
        records.push(record.get());
      }

      return Result.Ok({ type: 'outbox_batch_claimed', records });
    } catch (error) {
      return Result.Error(mapDbError(error));
    }
  }

  async markPublished(
    input: Parameters<OutboxRepository['markPublished']>[0]
  ): ReturnType<OutboxRepository['markPublished']> {
    try {
      const [updated] = await this.db
        .update(outboxTable)
        .set({
          status: 'published',
          publishedAt: input.publishedAt,
          lastError: null,
        })
        .where(eq(outboxTable.id, input.id))
        .returning({ id: outboxTable.id });

      if (!updated) {
        return Result.Error(
          new AppError({
            code: 'OUTBOX_MARK_PUBLISHED_EMPTY_RESULT',
            category: 'system',
            status: 500,
            message: 'Outbox publish update returned no row',
          })
        );
      }

      return Result.Ok({ type: 'outbox_event_published' });
    } catch (error) {
      return Result.Error(mapDbError(error));
    }
  }

  async markFailed(
    input: Parameters<OutboxRepository['markFailed']>[0]
  ): ReturnType<OutboxRepository['markFailed']> {
    try {
      const [updated] = await this.db
        .update(outboxTable)
        .set({
          status: input.nextAttemptAt === null ? 'failed' : 'pending',
          attempts: sql`${outboxTable.attempts} + 1`,
          lastError: input.error,
          ...(input.nextAttemptAt === null
            ? {}
            : { availableAt: input.nextAttemptAt }),
        })
        .where(eq(outboxTable.id, input.id))
        .returning({ id: outboxTable.id });

      if (!updated) {
        return Result.Error(
          new AppError({
            code: 'OUTBOX_MARK_FAILED_EMPTY_RESULT',
            category: 'system',
            status: 500,
            message: 'Outbox failure update returned no row',
          })
        );
      }

      return Result.Ok({ type: 'outbox_event_failure_recorded' });
    } catch (error) {
      return Result.Error(mapDbError(error));
    }
  }
}

export interface OutboxRepositoryDrizzleDependencies {
  db: DbLike;
  /** Stamped on recorded envelopes for cross-environment attribution. */
  deployTarget?: string;
}

export function createOutboxRepository(
  dependencies: OutboxRepositoryDrizzleDependencies
): OutboxRepository {
  return observeRepository(
    new OutboxRepositoryDrizzle(dependencies.db, dependencies.deployTarget),
    'outbox'
  );
}
