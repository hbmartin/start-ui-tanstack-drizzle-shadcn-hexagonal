import { Result } from '@bloodyowl/boxed';
import { makeBookRow, makeGenreRow } from '@tests/server/db-fixtures';
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

import type { AuditPort } from '@/modules/audit';
import {
  createAuditPort,
  createAuditRepository,
  createLoggerAuditFailureSignal,
} from '@/modules/audit/backend';
import { auditEvent as auditEventTable } from '@/modules/audit/persistence';
import { type BookCoverStorage, createBookUseCases } from '@/modules/book';
import { createBookRepository } from '@/modules/book/backend';
import {
  AppError,
  type ApplicationResult,
  toBookId,
  toCorrelationId,
  toGeneratedId,
  toUserId,
} from '@/modules/kernel';
import {
  createResultTransactionRunner,
  createTransactionRunner,
} from '@/modules/kernel/backend';
import {
  book as bookTable,
  genre as genreTable,
} from '@/modules/kernel/infrastructure/db/schema';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';
import { unwrapParseResult } from '@/modules/kernel/testing';

const now = new Date('2026-01-01T00:00:00.000Z');
const userId = unwrapParseResult(toUserId('admin-1'));
const bookId = unwrapParseResult(toBookId('book-1'));
const correlationId = unwrapParseResult(toCorrelationId('request-1'));
const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

const getOk = <TOutcome extends { type: string }>(
  result: ApplicationResult<TOutcome>
) => {
  if (result.isError()) throw result.getError();
  return result.get();
};

const createAudit = (db: DbLike, eventId: string) =>
  createAuditPort({
    clock: { now: () => now },
    failureSignal: createLoggerAuditFailureSignal(logger),
    idGenerator: { createId: () => toGeneratedId(eventId) },
    repository: createAuditRepository({ db }),
  });

const coverStorage = (
  deleteObject = vi.fn<BookCoverStorage['deleteObject']>(async () =>
    Result.Ok({ type: 'cover_object_deleted' })
  )
): BookCoverStorage => ({
  rememberUpload: async () => Result.Ok({ type: 'cover_upload_remembered' }),
  consumeUpload: async () => Result.Ok({ type: 'cover_upload_consumed' }),
  deleteObject,
});

describe('book deletion audit transaction', () => {
  let database: Awaited<ReturnType<typeof createPgliteTestDatabase>>;

  beforeAll(async () => {
    database = await createPgliteTestDatabase();
  });

  beforeEach(async () => {
    await database.truncate();
    await database.db
      .insert(genreTable)
      .values(makeGenreRow({ id: 'genre-1', name: 'Science Fiction' }));
    await database.db.insert(bookTable).values(
      makeBookRow({
        id: bookId,
        title: testBookTitle('Dune'),
        author: testBookAuthor('Frank Herbert'),
        genreId: 'genre-1',
        coverId: 'books/dune.webp',
      })
    );
  });

  afterAll(async () => {
    await database?.close();
  });

  const createUseCases = (
    eventId: string,
    storage = coverStorage(),
    auditOverride?: AuditPort
  ) =>
    createBookUseCases({
      bookRepository: createBookRepository({ db: database.db }),
      transactionRunner: createResultTransactionRunner({
        transactionRunner: createTransactionRunner(database.db),
        bindContext: (transaction) => ({
          audit: auditOverride ?? createAudit(transaction, eventId),
          bookRepository: createBookRepository({ db: transaction }),
        }),
      }),
      idGenerator: { createId: () => toGeneratedId('unused-book-id') },
      permissionChecker: {
        hasPermission: async () =>
          Result.Ok({ type: 'permission_granted' as const }),
      },
      coverStorage: storage,
      logger,
    });

  it('commits the book delete and audit event together', async () => {
    const result = await createUseCases('audit-delete-1').delete({
      correlationId,
      currentUserId: userId,
      id: bookId,
    });

    expect(getOk(result).type).toBe('book_deleted');
    await expect(database.db.select().from(bookTable)).resolves.toEqual([]);
    await expect(database.db.select().from(auditEventTable)).resolves.toEqual([
      expect.objectContaining({
        id: 'audit-delete-1',
        type: 'data.book-deleted',
        actorId: userId,
        subjectId: bookId,
        correlationId,
      }),
    ]);
  });

  it('rolls the book delete back when the required audit insert fails', async () => {
    const deleteObject = vi.fn<BookCoverStorage['deleteObject']>(async () =>
      Result.Ok({ type: 'cover_object_deleted' })
    );
    const auditError = new AppError({
      code: 'AUDIT_EVENT_PERSISTENCE_FAILED',
      category: 'system',
      status: 500,
    });
    const failedAudit = createAuditPort({
      clock: { now: () => now },
      failureSignal: createLoggerAuditFailureSignal(logger),
      idGenerator: { createId: () => toGeneratedId('audit-delete-failed') },
      repository: {
        append: async () => Result.Error(auditError),
      },
    });
    const result = await createUseCases(
      'unused-audit-id',
      coverStorage(deleteObject),
      failedAudit
    ).delete({
      correlationId,
      currentUserId: userId,
      id: bookId,
    });

    expect(result.isError()).toBe(true);
    await expect(database.db.select().from(bookTable)).resolves.toHaveLength(1);
    await expect(database.db.select().from(auditEventTable)).resolves.toEqual(
      []
    );
    expect(deleteObject).not.toHaveBeenCalled();
  });
});
