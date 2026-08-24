import { Result } from '@bloodyowl/boxed';

import type { BookId, UserId } from '@/modules/kernel/domain/ids';

import type { BookResult, BookUpdateOutcome, BookUseCaseDeps } from './types';
import type { BookWriteInput } from '../../domain/book';
import { normalizeBookWriteInput } from '../../domain/book';

export type UpdateBookInput = {
  currentUserId: UserId;
  id: BookId;
  book: BookWriteInput;
};

export async function updateBook(
  deps: BookUseCaseDeps,
  input: UpdateBookInput
): Promise<BookResult<BookUpdateOutcome>> {
  const allowed = await deps.permissionChecker.hasPermission(
    input.currentUserId,
    { book: ['update'] }
  );
  if (allowed.isError()) return Result.Error(allowed.getError());
  if (allowed.get().type === 'permission_denied') {
    return Result.Ok({ type: 'book_forbidden' });
  }

  const book = normalizeBookWriteInput(input.book);

  // Resolve the existing cover so an unchanged cover can be resubmitted without
  // requiring a fresh upload token. Superseded-cover cleanup uses the
  // repository update result so it reflects the write boundary.
  const currentResult = await deps.bookRepository.getById(input.id);
  if (currentResult.isError()) return Result.Error(currentResult.getError());
  const currentOutcome = currentResult.get();
  if (currentOutcome.type === 'book_not_found') {
    return Result.Ok({ type: 'book_not_found' });
  }
  const previousCoverId = currentOutcome.book.coverId;
  const coverChanged = book.coverId !== previousCoverId;
  let consumedCoverId: typeof book.coverId = null;

  if (coverChanged && book.coverId) {
    const consumed = await deps.coverStorage.consumeUpload(
      book.coverId,
      input.currentUserId
    );
    if (consumed.isError()) return Result.Error(consumed.getError());
    if (consumed.get().type === 'cover_upload_unowned') {
      return Result.Ok({ type: 'book_cover_unowned' });
    }
    consumedCoverId = book.coverId;
  }

  const reclaimConsumedCover = async () => {
    if (!consumedCoverId) return;

    const deleted = await deps.coverStorage.deleteObject(consumedCoverId);
    if (deleted.isError()) {
      deps.logger.warn({
        event: 'book.cover_object.delete_failed',
        details: { bookId: input.id, objectKey: consumedCoverId },
      });
    }
  };

  deps.logger.info({
    event: 'book.update',
    details: { bookId: input.id },
  });
  const result = await deps.transactionRunner.run(({ bookRepository }) =>
    bookRepository.update(input.id, book)
  );
  if (result.isError()) {
    await reclaimConsumedCover();
    return Result.Error(result.getError());
  }
  const updated = result.get();

  if (updated.type !== 'book_updated' && consumedCoverId) {
    await reclaimConsumedCover();
  }

  // Reclaim the superseded cover object. Best-effort: a delete failure is
  // logged but does not fail the update — the book has already changed.
  const replacedCoverId =
    updated.type === 'book_updated' ? updated.replacedCoverId : null;
  if (
    updated.type === 'book_updated' &&
    replacedCoverId &&
    replacedCoverId !== book.coverId
  ) {
    const deleted = await deps.coverStorage.deleteObject(replacedCoverId);
    if (deleted.isError()) {
      deps.logger.warn({
        event: 'book.cover_object.delete_failed',
        details: { bookId: input.id, objectKey: replacedCoverId },
      });
    }
  }

  return Result.Ok(updated);
}
