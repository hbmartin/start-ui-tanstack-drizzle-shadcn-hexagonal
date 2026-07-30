import { createPgliteTestDatabase } from '@tests/server/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { toOutboxEventId } from '@/modules/kernel/domain/ids';
import { createTransactionRunner } from '@/modules/kernel/infrastructure/db/client';
import { createOutboxRepository } from '@/modules/kernel/infrastructure/db/outbox-repository-drizzle';
import { outbox as outboxTable } from '@/modules/kernel/infrastructure/db/schema';
import type { ApplicationResult } from '@/modules/kernel/testing';
import { unwrapParseResult } from '@/modules/kernel/testing';

// Anchored to the wall clock because inserted rows default `availableAt` to
// the database's now(); fixed historical dates would never be "due".
const now = new Date();
const later = new Date(now.getTime() + 3_600_000);

const makeEnvelope = (overrides: Record<string, unknown> = {}) => ({
  type: 'book.created',
  aggregateType: 'book',
  aggregateId: 'book-1',
  payload: { bookId: 'book-1', title: 'Dune', author: 'Frank Herbert' },
  ...overrides,
});

function getOk<TOutcome extends { type: string }>(
  result: ApplicationResult<TOutcome>
) {
  if (result.isError()) throw result.getError();
  return result.get();
}

describe('OutboxRepositoryDrizzle integration', () => {
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

  it('records envelopes as due pending events stamped with the deploy target', async () => {
    const repository = createOutboxRepository({
      db: database.db,
      deployTarget: 'test-target',
    });

    const recorded = getOk(await repository.record(makeEnvelope()));
    expect(recorded).toMatchObject({
      type: 'outbox_event_recorded',
      record: {
        type: 'book.created',
        aggregateType: 'book',
        aggregateId: 'book-1',
        payload: { bookId: 'book-1', title: 'Dune', author: 'Frank Herbert' },
        deployTarget: 'test-target',
        status: 'pending',
        attempts: 0,
        publishedAt: null,
      },
    });

    const claimed = getOk(
      await repository.claimBatch({ limit: 10, now: later })
    );
    expect(claimed.records).toHaveLength(1);
  });

  it('dedupes envelopes sharing a dedupe key', async () => {
    const repository = createOutboxRepository({ db: database.db });

    const first = getOk(
      await repository.record(makeEnvelope({ dedupeKey: 'book-1:created' }))
    );
    const second = getOk(
      await repository.record(makeEnvelope({ dedupeKey: 'book-1:created' }))
    );

    expect(first.type).toBe('outbox_event_recorded');
    expect(second).toEqual({ type: 'outbox_event_deduplicated' });

    const rows = await database.db.select().from(outboxTable);
    expect(rows).toHaveLength(1);
  });

  it('claims only due pending events and honors the batch limit', async () => {
    const repository = createOutboxRepository({ db: database.db });
    await repository.record(makeEnvelope({ aggregateId: 'book-1' }));
    await repository.record(makeEnvelope({ aggregateId: 'book-2' }));
    await repository.record(makeEnvelope({ aggregateId: 'book-3' }));

    const limited = getOk(
      await repository.claimBatch({ limit: 2, now: later })
    );
    expect(limited.records).toHaveLength(2);

    const beforeAnyDue = getOk(
      await repository.claimBatch({
        limit: 10,
        now: new Date('2020-01-01T00:00:00.000Z'),
      })
    );
    expect(beforeAnyDue.records).toHaveLength(0);
  });

  it('marks events published and stops claiming them', async () => {
    const repository = createOutboxRepository({ db: database.db });
    const recorded = getOk(await repository.record(makeEnvelope()));
    if (recorded.type !== 'outbox_event_recorded') {
      throw new Error('expected recorded event');
    }

    getOk(
      await repository.markPublished({
        id: recorded.record.id,
        publishedAt: now,
      })
    );

    const claimed = getOk(
      await repository.claimBatch({ limit: 10, now: later })
    );
    expect(claimed.records).toHaveLength(0);

    const [row] = await database.db
      .select()
      .from(outboxTable)
      .where(eq(outboxTable.id, recorded.record.id));
    expect(row).toMatchObject({ status: 'published', publishedAt: now });
  });

  it('reschedules failures with attempts and backoff, and exhausts terminally', async () => {
    const repository = createOutboxRepository({ db: database.db });
    const recorded = getOk(await repository.record(makeEnvelope()));
    if (recorded.type !== 'outbox_event_recorded') {
      throw new Error('expected recorded event');
    }
    const id = recorded.record.id;

    getOk(
      await repository.markFailed({
        id,
        error: 'consumer: boom',
        nextAttemptAt: later,
      })
    );

    const [rescheduled] = await database.db
      .select()
      .from(outboxTable)
      .where(eq(outboxTable.id, id));
    expect(rescheduled).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'consumer: boom',
      availableAt: later,
    });

    // Not due before the rescheduled time, due after it.
    expect(
      getOk(await repository.claimBatch({ limit: 10, now })).records
    ).toHaveLength(0);
    expect(
      getOk(await repository.claimBatch({ limit: 10, now: later })).records
    ).toHaveLength(1);

    getOk(
      await repository.markFailed({
        id,
        error: 'consumer: boom again',
        nextAttemptAt: null,
      })
    );

    const [exhausted] = await database.db
      .select()
      .from(outboxTable)
      .where(eq(outboxTable.id, id));
    expect(exhausted).toMatchObject({ status: 'failed', attempts: 2 });
    expect(
      getOk(await repository.claimBatch({ limit: 10, now: later })).records
    ).toHaveLength(0);
  });

  it('serializes claim SQL with row locks inside a transaction', async () => {
    const repository = createOutboxRepository({ db: database.db });
    await repository.record(makeEnvelope());
    const transactionRunner = createTransactionRunner(database.db);

    // Exercises SELECT ... FOR UPDATE SKIP LOCKED against real Postgres SQL —
    // the lock is what makes concurrent drains skip in-flight rows.
    const claimed = await transactionRunner.run(async (tx) => {
      const txRepository = createOutboxRepository({ db: tx });
      return getOk(await txRepository.claimBatch({ limit: 10, now: later }));
    });

    expect(claimed.records).toHaveLength(1);
  });

  it('surfaces missing rows on publish/failure marks as errors', async () => {
    const repository = createOutboxRepository({ db: database.db });
    const missingId = unwrapParseResult(toOutboxEventId('missing'));

    const published = await repository.markPublished({
      id: missingId,
      publishedAt: now,
    });
    expect(published.isError()).toBe(true);

    const failed = await repository.markFailed({
      id: missingId,
      error: 'boom',
      nextAttemptAt: null,
    });
    expect(failed.isError()).toBe(true);
  });
});
