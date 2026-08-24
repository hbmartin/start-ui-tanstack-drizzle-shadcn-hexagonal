import { Result } from '@bloodyowl/boxed';

import { toAuditSubjectId } from '@/modules/audit';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import {
  type BookId,
  type CorrelationId,
  type UserId,
} from '@/modules/kernel/domain/ids';

import type { BookDeleteOutcome, BookResult, BookUseCaseDeps } from './types';
import type { BookDeleteRepositoryOutcome } from '../ports/book-repository';

export type DeleteBookInput = {
  correlationId: CorrelationId;
  currentUserId: UserId;
  id: BookId;
};

export async function deleteBook(
  deps: BookUseCaseDeps,
  input: DeleteBookInput
): Promise<BookResult<BookDeleteOutcome>> {
  const allowed = await deps.permissionChecker.hasPermission(
    input.currentUserId,
    { book: ['delete'] }
  );
  if (allowed.isError()) return Result.Error(allowed.getError());
  if (allowed.get().type === 'permission_denied') {
    return Result.Ok({ type: 'book_forbidden' });
  }

  const subjectId = toAuditSubjectId('book', input.id);
  if (subjectId.isError()) return Result.Error(subjectId.getError());

  deps.logger.info({
    event: 'book.delete',
    correlationId: input.correlationId,
    details: { bookId: input.id },
  });
  const result = await deps.transactionRunner.run(
    async ({
      audit,
      bookRepository,
    }): Promise<BookResult<BookDeleteRepositoryOutcome>> => {
      const deletion = await bookRepository.delete(input.id);
      if (deletion.isError()) return Result.Error(deletion.getError());
      const outcome = deletion.get();
      if (outcome.type === 'book_not_found') return Result.Ok(outcome);

      const recorded = await audit.record({
        type: 'data.book-deleted',
        actor: { kind: 'user', userId: input.currentUserId },
        subject: { kind: 'book', id: subjectId.get() },
        correlationId: input.correlationId,
        metadata: {},
      });
      if (recorded.isError()) return Result.Error(recorded.getError());
      if (recorded.get().type !== 'audit_recorded') {
        return Result.Error(
          new AppError({
            code: 'REQUIRED_AUDIT_EVENT_NOT_RECORDED',
            category: 'system',
            status: 500,
            message: 'Required book deletion audit event was not recorded',
          })
        );
      }

      return Result.Ok(outcome);
    }
  );
  if (result.isError()) return Result.Error(result.getError());
  const deleted = result.get();

  // Reclaim only after the database delete and required audit event commit.
  // Object cleanup remains best-effort because it cannot join that transaction.
  if (deleted.type === 'book_deleted' && deleted.deletedCoverId) {
    const removed = await deps.coverStorage.deleteObject(
      deleted.deletedCoverId
    );
    if (removed.isError()) {
      deps.logger.warn({
        event: 'book.cover_object.delete_failed',
        details: { bookId: input.id, objectKey: deleted.deletedCoverId },
      });
    }
  }

  return Result.Ok(deleted);
}
