import type {
  ApplicationResult,
  IdGenerator,
  Logger,
  OutboxRepository,
  PermissionChecker,
  TransactionRunner,
} from '@/modules/kernel';
import type { BookCoverObjectKey } from '@/modules/kernel/domain/ids';

import type { BookCoverStorage } from '../ports/book-cover-storage';
import type {
  BookCreateRepositoryOutcome,
  BookDeleteRepositoryOutcome,
  BookGetRepositoryOutcome,
  BookListRepositoryOutcome,
  BookRepository,
  BookUpdateRepositoryOutcome,
} from '../ports/book-repository';

export type BookTransactionContext = {
  bookRepository: BookRepository;
  /** Lifecycle events are appended in the same transaction as the write. */
  outboxRepository: OutboxRepository;
};

export type BookUseCaseDeps = {
  bookRepository: BookRepository;
  transactionRunner: TransactionRunner<BookTransactionContext>;
  idGenerator: IdGenerator;
  permissionChecker: PermissionChecker;
  coverStorage: BookCoverStorage;
  logger: Logger;
};

export type BookForbiddenOutcome = { type: 'book_forbidden' };

/**
 * The submitted `coverId` was not a key issued to this caller (or its short
 * binding window expired) — the caller must re-upload the cover.
 */
export type BookCoverUnownedOutcome = { type: 'book_cover_unowned' };

export type BookListOutcome = BookListRepositoryOutcome | BookForbiddenOutcome;

export type BookGetOutcome = BookGetRepositoryOutcome | BookForbiddenOutcome;

export type BookCreateOutcome =
  | BookCreateRepositoryOutcome
  | BookForbiddenOutcome
  | BookCoverUnownedOutcome;

export type BookUpdateOutcome =
  | BookUpdateRepositoryOutcome
  | BookForbiddenOutcome
  | BookCoverUnownedOutcome;

export type BookDeleteOutcome =
  | BookDeleteRepositoryOutcome
  | BookForbiddenOutcome;

export type PreparedBookCoverUpload = {
  objectKey: BookCoverObjectKey;
};

export type BookCoverUploadOutcome =
  | { type: 'book_cover_upload_prepared'; upload: PreparedBookCoverUpload }
  | { type: 'book_cover_upload_forbidden' }
  | { type: 'book_cover_upload_invalid_file_type' };

export type BookResult<TOutcome> = ApplicationResult<TOutcome>;
