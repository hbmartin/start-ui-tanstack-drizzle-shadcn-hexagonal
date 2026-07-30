import { Result } from '@bloodyowl/boxed';
import { testBookAuthor, testBookTitle } from '@tests/support/branded-values';
import { describe, expect, it, vi } from 'vitest';

import type { BookCoverStorage, BookRepository } from '@/modules/book';
import type { BookUseCaseDeps } from '@/modules/book/application/use-cases/types';
import type { Book } from '@/modules/book/domain/book';
import { createBookUseCases } from '@/modules/book/factory';
import {
  AppError,
  type OutboxRepository,
  type PermissionChecker,
} from '@/modules/kernel';
import {
  toBookCoverObjectKey,
  toBookId,
  toGeneratedId,
  toGenreId,
  toUserId,
} from '@/modules/kernel';
import type { ApplicationResult } from '@/modules/kernel/testing';
import { unwrapParseResult } from '@/modules/kernel/testing';

const now = new Date('2026-01-01T00:00:00.000Z');
const book: Book = {
  id: unwrapParseResult(toBookId('book-1')),
  title: testBookTitle('Dune'),
  author: testBookAuthor('Frank Herbert'),
  genreId: unwrapParseResult(toGenreId('genre-1')),
  genre: null,
  publisher: null,
  coverId: null,
  createdAt: now,
  updatedAt: now,
};

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
const idGenerator = {
  createId: () => toGeneratedId('generated-cover-id'),
};

const allowed: PermissionChecker = {
  hasPermission: async () => Result.Ok({ type: 'permission_granted' }),
};

const forbidden: PermissionChecker = {
  hasPermission: async () => Result.Ok({ type: 'permission_denied' }),
};

const scope = {
  userId: unwrapParseResult(toUserId('user-1')),
  role: 'user',
} as const;

function makeRepo(overrides: Partial<BookRepository> = {}): BookRepository {
  return {
    list: async () =>
      Result.Ok({
        type: 'book_listed',
        page: { items: [book], total: 1 },
      }),
    findDuplicateCandidate: async () =>
      Result.Ok({ type: 'book_duplicate_candidate_not_found' }),
    getById: async () => Result.Ok({ type: 'book_found', book }),
    create: async () => Result.Ok({ type: 'book_created', book }),
    update: async () =>
      Result.Ok({ type: 'book_updated', book, replacedCoverId: null }),
    delete: async () =>
      Result.Ok({ type: 'book_deleted', deletedCoverId: null }),
    ...overrides,
  };
}

function makeOutboxRepository(
  overrides: Partial<OutboxRepository> = {}
): OutboxRepository {
  return {
    record: vi.fn(async () =>
      Result.Ok({ type: 'outbox_event_deduplicated' as const })
    ),
    claimBatch: vi.fn(),
    markPublished: vi.fn(),
    markFailed: vi.fn(),
    ...overrides,
  } as OutboxRepository;
}

function makeCoverStorage(
  overrides: Partial<BookCoverStorage> = {}
): BookCoverStorage {
  return {
    rememberUpload: async () =>
      Result.Ok({ type: 'cover_upload_remembered' as const }),
    consumeUpload: async () =>
      Result.Ok({ type: 'cover_upload_consumed' as const }),
    deleteObject: async () =>
      Result.Ok({ type: 'cover_object_deleted' as const }),
    ...overrides,
  };
}

function makeDeps(
  input: {
    bookRepository?: BookRepository;
    permissionChecker?: PermissionChecker;
    coverStorage?: BookCoverStorage;
    outboxRepository?: OutboxRepository;
    onTransactionRun?: () => void;
  } = {}
): BookUseCaseDeps {
  const bookRepository = input.bookRepository ?? makeRepo();
  const outboxRepository = input.outboxRepository ?? makeOutboxRepository();

  return {
    bookRepository,
    transactionRunner: {
      run: (work) => {
        input.onTransactionRun?.();
        return work({ bookRepository, outboxRepository });
      },
    },
    idGenerator,
    permissionChecker: input.permissionChecker ?? allowed,
    coverStorage: input.coverStorage ?? makeCoverStorage(),
    logger,
  };
}

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
    throw new Error(`Expected Result.Error, got ${result.get().type}`);
  }
  return result.getError();
}

describe('book use cases', () => {
  it('lists books and returns forbidden when permission is missing', async () => {
    const listed = await createBookUseCases(makeDeps()).list({
      currentUserId: scope.userId,
      limit: 20,
      searchTerm: '',
    });

    expect(getOk(listed)).toMatchObject({
      type: 'book_listed',
      page: { total: 1 },
    });

    const denied = await createBookUseCases(
      makeDeps({ permissionChecker: forbidden })
    ).list({
      currentUserId: scope.userId,
      limit: 20,
      searchTerm: '',
    });

    expect(getOk(denied)).toEqual({ type: 'book_forbidden' });
  });

  it('gets a book or returns not_found', async () => {
    const missing = await createBookUseCases(
      makeDeps({
        bookRepository: makeRepo({
          getById: async () => Result.Ok({ type: 'book_not_found' }),
        }),
      })
    ).get({
      currentUserId: scope.userId,
      id: unwrapParseResult(toBookId('missing')),
    });

    expect(getOk(missing)).toEqual({ type: 'book_not_found' });
  });

  const emptyListPage = {
    type: 'book_listed' as const,
    page: { items: [], total: 0 },
  };

  it('creates when no existing book matches', async () => {
    const repo = makeRepo({
      findDuplicateCandidate: async () =>
        Result.Ok({ type: 'book_duplicate_candidate_not_found' }),
    });

    const created = await createBookUseCases(
      makeDeps({ bookRepository: repo })
    ).create({
      currentUserId: scope.userId,
      book,
    });

    expect(getOk(created)).toEqual({ type: 'book_created', book });
  });

  it('maps duplicate conflicts surfaced by the repository', async () => {
    const duplicateRepo = makeRepo({
      create: async () => Result.Ok({ type: 'book_duplicate' }),
      findDuplicateCandidate: async () =>
        Result.Ok({ type: 'book_duplicate_candidate_not_found' }),
    });

    const duplicate = await createBookUseCases(
      makeDeps({ bookRepository: duplicateRepo })
    ).create({
      currentUserId: scope.userId,
      book,
    });

    expect(getOk(duplicate)).toEqual({ type: 'book_duplicate' });
  });

  it('rejects case-insensitive duplicates in the pre-check without inserting', async () => {
    const create = vi.fn(async () =>
      Result.Ok({ type: 'book_created' as const, book })
    );
    const list = vi.fn(async () => Result.Ok(emptyListPage));
    const repo = makeRepo({
      create,
      list,
      findDuplicateCandidate: async () =>
        Result.Ok({ type: 'book_duplicate_candidate_found', book }),
    });

    const duplicate = await createBookUseCases(
      makeDeps({ bookRepository: repo })
    ).create({
      currentUserId: scope.userId,
      book: {
        ...book,
        title: testBookTitle('  dune '),
        author: testBookAuthor('FRANK HERBERT'),
      },
    });

    expect(getOk(duplicate)).toEqual({ type: 'book_duplicate' });
    expect(create).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('updates and deletes with not_found branches', async () => {
    let transactionRuns = 0;
    const useCases = createBookUseCases(
      makeDeps({
        bookRepository: makeRepo({
          update: async () => Result.Ok({ type: 'book_not_found' }),
          delete: async () => Result.Ok({ type: 'book_not_found' }),
        }),
        onTransactionRun: () => {
          transactionRuns += 1;
        },
      })
    );

    const updated = await useCases.update({
      currentUserId: scope.userId,
      id: unwrapParseResult(toBookId('missing')),
      book,
    });

    expect(getOk(updated)).toEqual({ type: 'book_not_found' });
    expect(transactionRuns).toBe(1);
    const deleted = await useCases.delete({
      currentUserId: scope.userId,
      id: unwrapParseResult(toBookId('missing')),
    });

    expect(getOk(deleted)).toEqual({ type: 'book_not_found' });
    expect(transactionRuns).toBe(1);
  });

  it('uses the transaction context repository for updates', async () => {
    const outsideRepository = makeRepo({
      update: async () => {
        throw new Error('outside repository should not update');
      },
    });
    const transactionRepository = makeRepo({
      update: async () =>
        Result.Ok({ type: 'book_updated', book, replacedCoverId: null }),
    });
    const useCases = createBookUseCases({
      ...makeDeps({ bookRepository: outsideRepository }),
      transactionRunner: {
        run: (work) =>
          work({
            bookRepository: transactionRepository,
            outboxRepository: makeOutboxRepository(),
          }),
      },
    });

    const updated = await useCases.update({
      currentUserId: scope.userId,
      id: unwrapParseResult(toBookId('book-1')),
      book,
    });

    expect(getOk(updated)).toEqual({
      type: 'book_updated',
      book,
      replacedCoverId: null,
    });
  });

  it('prepares cover uploads through permission and object-key policy', async () => {
    const prepared = await createBookUseCases(makeDeps()).prepareCoverUpload({
      currentUserId: scope.userId,
      fileType: 'image/webp',
    });
    expect(getOk(prepared)).toEqual({
      type: 'book_cover_upload_prepared',
      upload: { objectKey: 'books/generated-cover-id.webp' },
    });

    const denied = await createBookUseCases(
      makeDeps({ permissionChecker: forbidden })
    ).prepareCoverUpload({
      currentUserId: scope.userId,
      fileType: 'image/webp',
    });
    expect(getOk(denied)).toEqual({ type: 'book_cover_upload_forbidden' });

    const invalid = await createBookUseCases(makeDeps()).prepareCoverUpload({
      currentUserId: scope.userId,
      fileType: 'text/plain',
    });
    expect(getOk(invalid)).toEqual({
      type: 'book_cover_upload_invalid_file_type',
    });
  });

  describe('cover upload-key binding and object reclamation', () => {
    const coverKey = unwrapParseResult(
      toBookCoverObjectKey('books/generated-cover-id.webp')
    );
    const bookWithCover = { ...book, coverId: coverKey };

    it('remembers the issued key against the caller when preparing an upload', async () => {
      const rememberUpload = vi.fn(async () =>
        Result.Ok({ type: 'cover_upload_remembered' as const })
      );

      await createBookUseCases(
        makeDeps({ coverStorage: makeCoverStorage({ rememberUpload }) })
      ).prepareCoverUpload({
        currentUserId: scope.userId,
        fileType: 'image/webp',
      });

      expect(rememberUpload).toHaveBeenCalledWith(coverKey, scope.userId);
    });

    it('consumes the binding on create and rejects a cover not issued to the caller', async () => {
      const consumeUpload = vi.fn(async () =>
        Result.Ok({ type: 'cover_upload_unowned' as const })
      );
      const create = vi.fn(async () =>
        Result.Ok({ type: 'book_created' as const, book: bookWithCover })
      );

      const result = await createBookUseCases(
        makeDeps({
          bookRepository: makeRepo({ create }),
          coverStorage: makeCoverStorage({ consumeUpload }),
        })
      ).create({
        currentUserId: scope.userId,
        book: { ...book, coverId: coverKey },
      });

      expect(getOk(result)).toEqual({ type: 'book_cover_unowned' });
      expect(consumeUpload).toHaveBeenCalledWith(coverKey, scope.userId);
      expect(create).not.toHaveBeenCalled();
    });

    it('does not consume a binding on create when no cover is attached', async () => {
      const consumeUpload = vi.fn(async () =>
        Result.Ok({ type: 'cover_upload_consumed' as const })
      );

      await createBookUseCases(
        makeDeps({ coverStorage: makeCoverStorage({ consumeUpload }) })
      ).create({ currentUserId: scope.userId, book });

      expect(consumeUpload).not.toHaveBeenCalled();
    });

    it('reclaims a consumed cover when create is rejected after consumption', async () => {
      const consumeUpload = vi.fn(async () =>
        Result.Ok({ type: 'cover_upload_consumed' as const })
      );
      const deleteObject = vi.fn(async () =>
        Result.Ok({ type: 'cover_object_deleted' as const })
      );

      const result = await createBookUseCases(
        makeDeps({
          bookRepository: makeRepo({
            create: async () => Result.Ok({ type: 'book_duplicate' }),
          }),
          coverStorage: makeCoverStorage({ consumeUpload, deleteObject }),
        })
      ).create({
        currentUserId: scope.userId,
        book: { ...book, coverId: coverKey },
      });

      expect(getOk(result)).toEqual({ type: 'book_duplicate' });
      expect(consumeUpload).toHaveBeenCalledWith(coverKey, scope.userId);
      expect(deleteObject).toHaveBeenCalledWith(coverKey);
    });

    it('reclaims a consumed cover when create fails after consumption', async () => {
      const error = new AppError({
        code: 'BOOK_CREATE_FAILED',
        category: 'system',
        status: 500,
      });
      const consumeUpload = vi.fn(async () =>
        Result.Ok({ type: 'cover_upload_consumed' as const })
      );
      const deleteObject = vi.fn(async () =>
        Result.Ok({ type: 'cover_object_deleted' as const })
      );

      const result = await createBookUseCases(
        makeDeps({
          bookRepository: makeRepo({
            create: async () => Result.Error(error),
          }),
          coverStorage: makeCoverStorage({ consumeUpload, deleteObject }),
        })
      ).create({
        currentUserId: scope.userId,
        book: { ...book, coverId: coverKey },
      });

      expect(getError(result)).toBe(error);
      expect(consumeUpload).toHaveBeenCalledWith(coverKey, scope.userId);
      expect(deleteObject).toHaveBeenCalledWith(coverKey);
    });

    it('on update consumes the binding and reclaims the previous cover only when the cover changes', async () => {
      const consumeUpload = vi.fn(async () =>
        Result.Ok({ type: 'cover_upload_consumed' as const })
      );
      const deleteObject = vi.fn(async () =>
        Result.Ok({ type: 'cover_object_deleted' as const })
      );
      const previousKey = unwrapParseResult(
        toBookCoverObjectKey('books/old-cover.png')
      );
      const newKey = unwrapParseResult(
        toBookCoverObjectKey('books/new-cover.webp')
      );

      const result = await createBookUseCases(
        makeDeps({
          bookRepository: makeRepo({
            getById: async () =>
              Result.Ok({
                type: 'book_found',
                book: { ...book, coverId: previousKey },
              }),
            update: async () =>
              Result.Ok({
                type: 'book_updated',
                book: { ...book, coverId: newKey },
                replacedCoverId: previousKey,
              }),
          }),
          coverStorage: makeCoverStorage({ consumeUpload, deleteObject }),
        })
      ).update({
        currentUserId: scope.userId,
        id: book.id,
        book: { ...book, coverId: newKey },
      });

      expect(getOk(result)).toMatchObject({ type: 'book_updated' });
      expect(consumeUpload).toHaveBeenCalledWith(newKey, scope.userId);
      expect(deleteObject).toHaveBeenCalledWith(previousKey);
    });

    it('on update still succeeds when previous-cover reclamation fails', async () => {
      const consumeUpload = vi.fn(async () =>
        Result.Ok({ type: 'cover_upload_consumed' as const })
      );
      const deleteObject = vi.fn(async () =>
        Result.Error(
          new AppError({
            code: 'OBJECT_STORAGE_DELETE_FAILED',
            category: 'system',
            status: 502,
          })
        )
      );
      const previousKey = unwrapParseResult(
        toBookCoverObjectKey('books/old-cover.png')
      );
      const newKey = unwrapParseResult(
        toBookCoverObjectKey('books/new-cover.webp')
      );

      const result = await createBookUseCases(
        makeDeps({
          bookRepository: makeRepo({
            getById: async () =>
              Result.Ok({
                type: 'book_found',
                book: { ...book, coverId: previousKey },
              }),
            update: async () =>
              Result.Ok({
                type: 'book_updated',
                book: { ...book, coverId: newKey },
                replacedCoverId: previousKey,
              }),
          }),
          coverStorage: makeCoverStorage({ consumeUpload, deleteObject }),
        })
      ).update({
        currentUserId: scope.userId,
        id: book.id,
        book: { ...book, coverId: newKey },
      });

      expect(getOk(result)).toMatchObject({ type: 'book_updated' });
      expect(consumeUpload).toHaveBeenCalledWith(newKey, scope.userId);
      expect(deleteObject).toHaveBeenCalledWith(previousKey);
    });

    it('on update reclaims a consumed new cover when the write is rejected', async () => {
      const consumeUpload = vi.fn(async () =>
        Result.Ok({ type: 'cover_upload_consumed' as const })
      );
      const deleteObject = vi.fn(async () =>
        Result.Ok({ type: 'cover_object_deleted' as const })
      );
      const previousKey = unwrapParseResult(
        toBookCoverObjectKey('books/old-cover.png')
      );
      const newKey = unwrapParseResult(
        toBookCoverObjectKey('books/new-cover.webp')
      );

      const result = await createBookUseCases(
        makeDeps({
          bookRepository: makeRepo({
            getById: async () =>
              Result.Ok({
                type: 'book_found',
                book: { ...book, coverId: previousKey },
              }),
            update: async () => Result.Ok({ type: 'book_duplicate' }),
          }),
          coverStorage: makeCoverStorage({ consumeUpload, deleteObject }),
        })
      ).update({
        currentUserId: scope.userId,
        id: book.id,
        book: { ...book, coverId: newKey },
      });

      expect(getOk(result)).toEqual({ type: 'book_duplicate' });
      expect(consumeUpload).toHaveBeenCalledWith(newKey, scope.userId);
      expect(deleteObject).toHaveBeenCalledWith(newKey);
    });

    it('on update reclaims a consumed new cover when the write fails', async () => {
      const error = new AppError({
        code: 'BOOK_UPDATE_FAILED',
        category: 'system',
        status: 500,
      });
      const consumeUpload = vi.fn(async () =>
        Result.Ok({ type: 'cover_upload_consumed' as const })
      );
      const deleteObject = vi.fn(async () =>
        Result.Ok({ type: 'cover_object_deleted' as const })
      );
      const previousKey = unwrapParseResult(
        toBookCoverObjectKey('books/old-cover.png')
      );
      const newKey = unwrapParseResult(
        toBookCoverObjectKey('books/new-cover.webp')
      );

      const result = await createBookUseCases(
        makeDeps({
          bookRepository: makeRepo({
            getById: async () =>
              Result.Ok({
                type: 'book_found',
                book: { ...book, coverId: previousKey },
              }),
            update: async () => Result.Error(error),
          }),
          coverStorage: makeCoverStorage({ consumeUpload, deleteObject }),
        })
      ).update({
        currentUserId: scope.userId,
        id: book.id,
        book: { ...book, coverId: newKey },
      });

      expect(getError(result)).toBe(error);
      expect(consumeUpload).toHaveBeenCalledWith(newKey, scope.userId);
      expect(deleteObject).toHaveBeenCalledWith(newKey);
    });

    it('on update reclaims a consumed new cover when the transaction throws', async () => {
      const error = new AppError({
        code: 'BOOK_TRANSACTION_FAILED',
        category: 'system',
        status: 500,
      });
      const consumeUpload = vi.fn(async () =>
        Result.Ok({ type: 'cover_upload_consumed' as const })
      );
      const deleteObject = vi.fn(async () =>
        Result.Ok({ type: 'cover_object_deleted' as const })
      );
      const previousKey = unwrapParseResult(
        toBookCoverObjectKey('books/old-cover.png')
      );
      const newKey = unwrapParseResult(
        toBookCoverObjectKey('books/new-cover.webp')
      );

      const result = await createBookUseCases({
        ...makeDeps({
          bookRepository: makeRepo({
            getById: async () =>
              Result.Ok({
                type: 'book_found',
                book: { ...book, coverId: previousKey },
              }),
          }),
          coverStorage: makeCoverStorage({ consumeUpload, deleteObject }),
        }),
        transactionRunner: {
          run: async () => {
            throw error;
          },
        },
      }).update({
        currentUserId: scope.userId,
        id: book.id,
        book: { ...book, coverId: newKey },
      });

      expect(getError(result)).toBe(error);
      expect(consumeUpload).toHaveBeenCalledWith(newKey, scope.userId);
      expect(deleteObject).toHaveBeenCalledWith(newKey);
    });

    it('on update with an unchanged cover neither consumes a binding nor deletes the object', async () => {
      const consumeUpload = vi.fn(async () =>
        Result.Ok({ type: 'cover_upload_consumed' as const })
      );
      const deleteObject = vi.fn(async () =>
        Result.Ok({ type: 'cover_object_deleted' as const })
      );

      await createBookUseCases(
        makeDeps({
          bookRepository: makeRepo({
            getById: async () =>
              Result.Ok({ type: 'book_found', book: bookWithCover }),
            update: async () =>
              Result.Ok({
                type: 'book_updated',
                book: bookWithCover,
                replacedCoverId: coverKey,
              }),
          }),
          coverStorage: makeCoverStorage({ consumeUpload, deleteObject }),
        })
      ).update({
        currentUserId: scope.userId,
        id: book.id,
        book: { ...book, coverId: coverKey },
      });

      expect(consumeUpload).not.toHaveBeenCalled();
      expect(deleteObject).not.toHaveBeenCalled();
    });

    it('reclaims the cover object when a book is deleted', async () => {
      const deleteObject = vi.fn(async () =>
        Result.Ok({ type: 'cover_object_deleted' as const })
      );

      await createBookUseCases(
        makeDeps({
          bookRepository: makeRepo({
            getById: async () =>
              Result.Ok({ type: 'book_found', book: bookWithCover }),
            delete: async () =>
              Result.Ok({ type: 'book_deleted', deletedCoverId: coverKey }),
          }),
          coverStorage: makeCoverStorage({ deleteObject }),
        })
      ).delete({ currentUserId: scope.userId, id: book.id });

      expect(deleteObject).toHaveBeenCalledWith(coverKey);
    });

    it('does not fail the delete when cover-object reclamation fails (best-effort)', async () => {
      const deleteObject = vi.fn(async () =>
        Result.Error(
          new AppError({
            code: 'OBJECT_STORAGE_DELETE_FAILED',
            category: 'system',
            status: 502,
          })
        )
      );

      const result = await createBookUseCases(
        makeDeps({
          bookRepository: makeRepo({
            getById: async () =>
              Result.Ok({ type: 'book_found', book: bookWithCover }),
            delete: async () =>
              Result.Ok({ type: 'book_deleted', deletedCoverId: coverKey }),
          }),
          coverStorage: makeCoverStorage({ deleteObject }),
        })
      ).delete({ currentUserId: scope.userId, id: book.id });

      expect(getOk(result)).toEqual({
        type: 'book_deleted',
        deletedCoverId: coverKey,
      });
      expect(deleteObject).toHaveBeenCalled();
    });
  });

  describe('book.created lifecycle event', () => {
    it('records a book.created envelope in the same transaction as the insert', async () => {
      const outboxRepository = makeOutboxRepository();
      const created = await createBookUseCases(
        makeDeps({ outboxRepository })
      ).create({
        currentUserId: scope.userId,
        book,
      });

      expect(getOk(created)).toMatchObject({ type: 'book_created' });
      expect(outboxRepository.record).toHaveBeenCalledExactlyOnceWith({
        type: 'book.created',
        aggregateType: 'book',
        aggregateId: book.id,
        payload: {
          bookId: book.id,
          title: book.title,
          author: book.author,
        },
      });
    });

    it('fails the create when the outbox append fails so the write rolls back', async () => {
      const error = new AppError({
        code: 'OUTBOX_REPOSITORY_ERROR',
        category: 'system',
        status: 500,
        message: 'Outbox repository error',
      });
      const outboxRepository = makeOutboxRepository({
        record: async () => Result.Error(error),
      });

      const created = await createBookUseCases(
        makeDeps({ outboxRepository })
      ).create({
        currentUserId: scope.userId,
        book,
      });

      expect(getError(created)).toBe(error);
    });

    it('reclaims a consumed cover when the outbox append fails', async () => {
      const deleteObject = vi.fn(async () =>
        Result.Ok({ type: 'cover_object_deleted' as const })
      );
      const coverKey = unwrapParseResult(
        toBookCoverObjectKey('books/cover.webp')
      );
      const outboxRepository = makeOutboxRepository({
        record: async () =>
          Result.Error(
            new AppError({
              code: 'OUTBOX_REPOSITORY_ERROR',
              category: 'system',
              status: 500,
              message: 'Outbox repository error',
            })
          ),
      });

      const created = await createBookUseCases(
        makeDeps({
          outboxRepository,
          coverStorage: makeCoverStorage({ deleteObject }),
        })
      ).create({
        currentUserId: scope.userId,
        book: { ...book, coverId: coverKey },
      });

      expect(created.isError()).toBe(true);
      expect(deleteObject).toHaveBeenCalledWith(coverKey);
    });

    it('does not record an envelope for duplicate outcomes', async () => {
      const outboxRepository = makeOutboxRepository();

      const created = await createBookUseCases(
        makeDeps({
          outboxRepository,
          bookRepository: makeRepo({
            create: async () => Result.Ok({ type: 'book_duplicate' }),
          }),
        })
      ).create({
        currentUserId: scope.userId,
        book,
      });

      expect(getOk(created)).toEqual({ type: 'book_duplicate' });
      expect(outboxRepository.record).not.toHaveBeenCalled();
    });
  });
});
