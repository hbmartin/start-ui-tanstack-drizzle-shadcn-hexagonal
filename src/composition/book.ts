import { Result } from '@bloodyowl/boxed';

import {
  type BookCoverStorage,
  type BookRepository,
  type BookTransactionContext,
  createBookUseCases,
} from '@/modules/book';
import { createBookRepository as createBookRepositoryDrizzle } from '@/modules/book/infrastructure/drizzle/book-repository-drizzle';
import type {
  BookCoverObjectKey,
  OutboxRepository,
  TransactionRunner,
  UserId,
} from '@/modules/kernel';
import { BetterUploadObjectStorage } from '@/modules/kernel/backend';
import { createOutboxRepository } from '@/modules/kernel/infrastructure/db/outbox-repository-drizzle';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';

import { getSecondaryStore } from './auth';
import { getKernel, type Kernel } from './kernel';
import { createCachedFactory } from './shared/singleton';

export type BookOverrides = {
  kernel?: Kernel;
  bookRepository?: BookRepository;
  coverStorage?: BookCoverStorage;
  outboxRepository?: OutboxRepository;
};

const createBookRepository = (db: DbLike): BookRepository =>
  createBookRepositoryDrizzle({ db });

// Short window between issuing a presign and the user saving the book form.
const COVER_UPLOAD_BINDING_PREFIX = 'book:cover-upload:';
const COVER_UPLOAD_BINDING_TTL_SECONDS = 30 * 60;

/**
 * Binds issued cover keys to their uploader via the shared SecondaryStore
 * (durable on Upstash; per-process otherwise — see `docs/security-upload.md`)
 * and reclaims cover objects through the S3 storage adapter.
 */
const createBookCoverStorage = (): BookCoverStorage => {
  const secondaryStore = getSecondaryStore();
  const objectStorage = new BetterUploadObjectStorage();
  const bindingKey = (objectKey: BookCoverObjectKey) =>
    `${COVER_UPLOAD_BINDING_PREFIX}${objectKey}`;

  return {
    async rememberUpload(objectKey: BookCoverObjectKey, userId: UserId) {
      const result = await secondaryStore.set(
        bindingKey(objectKey),
        userId,
        COVER_UPLOAD_BINDING_TTL_SECONDS
      );
      if (result.isError()) return Result.Error(result.getError());
      return Result.Ok({ type: 'cover_upload_remembered' as const });
    },
    async consumeUpload(objectKey: BookCoverObjectKey, userId: UserId) {
      const taken = await secondaryStore.take(bindingKey(objectKey), userId);
      if (taken.isError()) return Result.Error(taken.getError());
      if (taken.get().type === 'secondary_store_miss') {
        return Result.Ok({ type: 'cover_upload_unowned' as const });
      }
      return Result.Ok({ type: 'cover_upload_consumed' as const });
    },
    async deleteObject(objectKey: BookCoverObjectKey) {
      const result = await objectStorage.deleteObject(objectKey);
      if (result.isError()) return Result.Error(result.getError());
      return Result.Ok({ type: 'cover_object_deleted' as const });
    },
  };
};

const createBookTransactionRunner = (
  kernel: Kernel,
  overrides?: Pick<BookOverrides, 'bookRepository' | 'outboxRepository'>
): TransactionRunner<BookTransactionContext> => {
  const bookRepositoryOverride = overrides?.bookRepository;
  const outboxRepositoryOverride = overrides?.outboxRepository;
  const createBoundOutboxRepository = (db: DbLike) =>
    outboxRepositoryOverride ??
    createOutboxRepository({ db, deployTarget: kernel.deployTarget });

  if (bookRepositoryOverride) {
    return {
      run: (work) =>
        work({
          bookRepository: bookRepositoryOverride,
          outboxRepository: createBoundOutboxRepository(kernel.db),
        }),
    };
  }

  return {
    run: (work, options) =>
      kernel.transactionRunner.run(
        (db) =>
          work({
            bookRepository: createBookRepository(db),
            outboxRepository: createBoundOutboxRepository(db),
          }),
        options
      ),
  };
};

const buildBookUseCases = (overrides?: BookOverrides) => {
  const kernel = overrides?.kernel ?? getKernel();
  const bookRepository =
    overrides?.bookRepository ?? createBookRepository(kernel.db);
  return createBookUseCases({
    bookRepository,
    transactionRunner: createBookTransactionRunner(kernel, {
      bookRepository: overrides?.bookRepository,
      outboxRepository: overrides?.outboxRepository,
    }),
    idGenerator: kernel.idGenerator,
    permissionChecker: kernel.permissionChecker,
    coverStorage: overrides?.coverStorage ?? createBookCoverStorage(),
    logger: kernel.logger,
  });
};

const factory = createCachedFactory(buildBookUseCases);

export const getBookUseCases = (overrides?: BookOverrides) =>
  factory.get(overrides);

/** Test-only. */
export const __resetBookComposition = () => factory.reset();
