import { Result } from '@bloodyowl/boxed';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import type { UserId } from '@/modules/kernel/domain/ids';

import type { BookCreateOutcome, BookResult, BookUseCaseDeps } from './types';
import type { BookWriteInput } from '../../domain/book';
import { normalizeBookWriteInput } from '../../domain/book';
import { isDuplicateBookCandidate } from '../../domain/book-policy';

export type CreateBookInput = {
  currentUserId: UserId;
  book: BookWriteInput;
};

export async function createBook(
  deps: BookUseCaseDeps,
  input: CreateBookInput
): Promise<BookResult<BookCreateOutcome>> {
  const allowed = await deps.permissionChecker.hasPermission(
    input.currentUserId,
    { book: ['create'] }
  );
  if (allowed.isError()) return Result.Error(allowed.getError());
  if (allowed.get().type === 'permission_denied') {
    return Result.Ok({ type: 'book_forbidden' });
  }

  const book = normalizeBookWriteInput(input.book);

  const duplicateCandidate = await deps.bookRepository.findDuplicateCandidate({
    title: book.title,
    author: book.author,
  });
  if (duplicateCandidate.isError()) {
    return Result.Error(duplicateCandidate.getError());
  }

  const candidate = duplicateCandidate.get();
  if (
    candidate.type === 'book_duplicate_candidate_found' &&
    isDuplicateBookCandidate(candidate.book, book)
  ) {
    return Result.Ok({ type: 'book_duplicate' });
  }

  let consumedCoverId = book.coverId;
  // A submitted cover must be a key this caller was issued (and not yet used).
  if (book.coverId) {
    const consumed = await deps.coverStorage.consumeUpload(
      book.coverId,
      input.currentUserId
    );
    if (consumed.isError()) return Result.Error(consumed.getError());
    if (consumed.get().type === 'cover_upload_unowned') {
      return Result.Ok({ type: 'book_cover_unowned' });
    }
  } else {
    consumedCoverId = null;
  }

  const reclaimConsumedCover = async () => {
    if (!consumedCoverId) return;

    const removed = await deps.coverStorage.deleteObject(consumedCoverId);
    if (removed.isError()) {
      deps.logger.warn({
        event: 'book.cover_object.delete_failed',
        details: { objectKey: consumedCoverId },
      });
    }
  };

  deps.logger.info({ event: 'book.create' });

  let result: Awaited<ReturnType<typeof deps.bookRepository.create>>;
  try {
    result = await deps.transactionRunner.run(
      async ({ bookRepository, outboxRepository }) => {
        const created = await bookRepository.create(book);
        if (created.isError()) return created;

        const outcome = created.get();
        if (outcome.type !== 'book_created') return created;

        const recorded = await outboxRepository.record({
          type: 'book.created',
          aggregateType: 'book',
          aggregateId: outcome.book.id,
          payload: {
            bookId: outcome.book.id,
            title: outcome.book.title,
            author: outcome.book.author,
          },
        });
        // The write and its lifecycle event are one atomic unit: throwing
        // rolls the insert back with the failed outbox append.
        if (recorded.isError()) throw recorded.getError();

        return created;
      }
    );
  } catch (error) {
    await reclaimConsumedCover();

    return Result.Error(
      error instanceof AppError
        ? error
        : new AppError({
            code: 'BOOK_TRANSACTION_ERROR',
            category: 'system',
            status: 500,
            message: 'Book transaction error',
            cause: error,
          })
    );
  }

  if (result.isError()) {
    await reclaimConsumedCover();

    return Result.Error(result.getError());
  }
  const created = result.get();

  if (created.type !== 'book_created') {
    await reclaimConsumedCover();
  }

  return Result.Ok(created);
}
