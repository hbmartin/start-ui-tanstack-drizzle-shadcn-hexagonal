import { Result } from '@bloodyowl/boxed';
import { makeGenreRow } from '@tests/server/db-fixtures';
import { createPgliteTestDatabase } from '@tests/server/pglite';
import { testBookAuthor, testBookTitle } from '@tests/support/branded-values';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { type BookCoverStorage, createBookUseCases } from '@/modules/book';
import { createBookRepository } from '@/modules/book/infrastructure/drizzle/book-repository-drizzle';
import type {
  ApplicationResult,
  Logger,
  OutboxEventRecord,
  PermissionChecker,
} from '@/modules/kernel';
import { AppError, toGeneratedId, toGenreId, toUserId } from '@/modules/kernel';
import { createTransactionRunner } from '@/modules/kernel/infrastructure/db/client';
import { createOutboxRepository } from '@/modules/kernel/infrastructure/db/outbox-repository-drizzle';
import {
  book as bookTable,
  genre as genreTable,
  outbox as outboxTable,
} from '@/modules/kernel/infrastructure/db/schema';
import { unwrapParseResult } from '@/modules/kernel/testing';
import {
  createConsumerRegistry,
  createLifecycleEventsUseCases,
  type LifecycleEventConsumer,
} from '@/modules/lifecycle-events';

const currentUserId = unwrapParseResult(toUserId('admin-1'));
const genreId = unwrapParseResult(toGenreId('genre-1'));

const logger: Logger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
};
const permissionChecker: PermissionChecker = {
  hasPermission: async () => Result.Ok({ type: 'permission_granted' }),
};
const coverStorage: BookCoverStorage = {
  rememberUpload: async () => Result.Ok({ type: 'cover_upload_remembered' }),
  consumeUpload: async () => Result.Ok({ type: 'cover_upload_consumed' }),
  deleteObject: async () => Result.Ok({ type: 'cover_object_deleted' }),
};

const bookInput = {
  author: testBookAuthor('Frank Herbert'),
  coverId: null,
  genreId,
  publisher: null,
  title: testBookTitle('Dune'),
};

function getOk<TOutcome extends { type: string }>(
  result: ApplicationResult<TOutcome>
) {
  if (result.isError()) throw result.getError();
  return result.get();
}

describe('transactional outbox workflow integration', () => {
  let database: Awaited<ReturnType<typeof createPgliteTestDatabase>>;

  beforeAll(async () => {
    database = await createPgliteTestDatabase();
  });

  beforeEach(async () => {
    await database.truncate();
    await database.db.insert(genreTable).values(makeGenreRow());
  });

  afterAll(async () => {
    await database?.close();
  });

  const makeBookUseCases = (options?: { failOutboxAppend?: boolean }) => {
    const base = createTransactionRunner(database.db);
    const failingOutboxRepository = {
      record: async () =>
        Result.Error(
          new AppError({
            code: 'OUTBOX_REPOSITORY_ERROR',
            category: 'system',
            status: 500,
            message: 'Outbox repository error',
          })
        ),
    };

    return createBookUseCases({
      bookRepository: createBookRepository({ db: database.db }),
      transactionRunner: {
        run: (work, runOptions) =>
          base.run(
            (tx) =>
              work({
                bookRepository: createBookRepository({ db: tx }),
                outboxRepository: options?.failOutboxAppend
                  ? (failingOutboxRepository as never)
                  : createOutboxRepository({
                      db: tx,
                      deployTarget: 'test-target',
                    }),
              }),
            runOptions
          ),
      },
      idGenerator: { createId: () => toGeneratedId('cover-id') },
      permissionChecker,
      coverStorage,
      logger,
    });
  };

  it('writes exactly one outbox row in the same transaction as the book insert', async () => {
    const created = await makeBookUseCases().create({
      currentUserId,
      book: bookInput,
    });

    expect(getOk(created)).toMatchObject({ type: 'book_created' });

    const books = await database.db.select().from(bookTable);
    const outboxRows = await database.db.select().from(outboxTable);
    expect(books).toHaveLength(1);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      type: 'book.created',
      aggregateType: 'book',
      aggregateId: books[0]?.id,
      deployTarget: 'test-target',
      status: 'pending',
      payload: {
        bookId: books[0]?.id,
        title: 'Dune',
        author: 'Frank Herbert',
      },
    });
  });

  it('rolls the book insert back when the outbox append fails', async () => {
    const created = await makeBookUseCases({ failOutboxAppend: true }).create({
      currentUserId,
      book: bookInput,
    });

    expect(created.isError()).toBe(true);

    const books = await database.db.select().from(bookTable);
    const outboxRows = await database.db.select().from(outboxTable);
    expect(books).toHaveLength(0);
    expect(outboxRows).toHaveLength(0);
  });

  it('drains recorded events to consumers and marks them published', async () => {
    await makeBookUseCases().create({ currentUserId, book: bookInput });

    const consumed: OutboxEventRecord[] = [];
    const consumer: LifecycleEventConsumer = {
      name: 'recording',
      handles: (eventType) => eventType === 'book.created',
      consume: async (event) => {
        consumed.push(event);
        return Result.Ok({ type: 'lifecycle_event_consumed' });
      },
    };
    const base = createTransactionRunner(database.db);
    const useCases = createLifecycleEventsUseCases({
      transactionRunner: {
        run: (work, runOptions) =>
          base.run(
            (tx) =>
              work({ outboxRepository: createOutboxRepository({ db: tx }) }),
            runOptions
          ),
      },
      consumerRegistry: createConsumerRegistry([consumer]),
      clock: { now: () => new Date() },
      logger,
      drainBatchSize: 10,
      maxAttempts: 3,
      baseBackoffMs: 1000,
    });

    const drained = await useCases.drain();
    expect(getOk(drained)).toMatchObject({
      type: 'outbox_drained',
      claimed: 1,
      published: 1,
    });
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ type: 'book.created' });

    const outboxRows = await database.db.select().from(outboxTable);
    expect(outboxRows[0]).toMatchObject({ status: 'published' });

    // A second drain finds nothing left to deliver.
    const redrained = await useCases.drain();
    expect(getOk(redrained)).toMatchObject({ claimed: 0 });
    expect(consumed).toHaveLength(1);
  });

  it('increments attempts and backs off when a consumer fails', async () => {
    await makeBookUseCases().create({ currentUserId, book: bookInput });

    // A fixed clock ahead of the insert's wall-clock `availableAt` default,
    // so the first drain claims the row and the backoff stays deterministic.
    const drainNow = new Date(Date.now() + 60_000);
    const consumer: LifecycleEventConsumer = {
      name: 'failing',
      handles: () => true,
      consume: vi.fn(async () =>
        Result.Error(
          new AppError({
            code: 'CONSUMER_FAILED',
            category: 'system',
            status: 500,
            message: 'boom',
          })
        )
      ),
    };
    const base = createTransactionRunner(database.db);
    const useCases = createLifecycleEventsUseCases({
      transactionRunner: {
        run: (work, runOptions) =>
          base.run(
            (tx) =>
              work({ outboxRepository: createOutboxRepository({ db: tx }) }),
            runOptions
          ),
      },
      consumerRegistry: createConsumerRegistry([consumer]),
      clock: { now: () => drainNow },
      logger,
      drainBatchSize: 10,
      maxAttempts: 3,
      baseBackoffMs: 1000,
    });

    const drained = await useCases.drain();
    expect(getOk(drained)).toMatchObject({
      type: 'outbox_drained',
      claimed: 1,
      retried: 1,
      exhausted: 0,
    });

    const [row] = await database.db.select().from(outboxTable);
    expect(row).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'failing: boom',
      availableAt: new Date(drainNow.getTime() + 1000),
    });

    // Not due yet, so an immediate re-drain claims nothing.
    const redrained = await useCases.drain();
    expect(getOk(redrained)).toMatchObject({ claimed: 0 });
  });
});
