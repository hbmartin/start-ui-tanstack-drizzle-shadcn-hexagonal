import { Result } from '@bloodyowl/boxed';

import {
  type BookCoverStorage,
  type BookRepository,
  type BookTransactionContext,
  createBookUseCases,
} from '@/modules/book';
import { createBookRepository as createBookRepositoryDrizzle } from '@/modules/book/backend';
import {
  ConfigurationError,
  type BookCoverObjectKey,
  type ResultTransactionRunner,
  type UserId,
} from '@/modules/kernel';
import {
  BetterUploadObjectStorage,
  createResultTransactionRunner,
} from '@/modules/kernel/backend';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';

import { getSecondaryStore } from './auth';
import { createTransactionAuditRecorder } from './audit';
import { getKernel, type Kernel } from './kernel';
import { createCachedFactory } from './shared/singleton';

export type BookOverrides = {
  kernel?: Kernel;
  bookRepository?: BookRepository;
  coverStorage?: BookCoverStorage;
  transactionRunner?: ResultTransactionRunner<BookTransactionContext>;
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
  kernel: Kernel
): ResultTransactionRunner<BookTransactionContext> =>
  createResultTransactionRunner({
    transactionRunner: kernel.transactionRunner,
    bindContext: (db) => ({
      audit: createTransactionAuditRecorder({
        kernel,
        transaction: db,
      }),
      bookRepository: createBookRepository(db),
    }),
  });

const unavailableBookTransactionRunner =
  (): ResultTransactionRunner<BookTransactionContext> => ({
    async run() {
      return Result.Error(
        new ConfigurationError(
          'A transaction runner is required with a book repository override.'
        )
      );
    },
  });

const resolveBookTransactionRunner = (
  kernel: Kernel,
  overrides?: BookOverrides
) => {
  if (overrides?.transactionRunner) return overrides.transactionRunner;
  if (overrides?.bookRepository) return unavailableBookTransactionRunner();
  return createBookTransactionRunner(kernel);
};

const buildBookUseCases = (overrides?: BookOverrides) => {
  const kernel = overrides?.kernel ?? getKernel();
  const bookRepository =
    overrides?.bookRepository ?? createBookRepository(kernel.db);
  return createBookUseCases({
    bookRepository,
    transactionRunner: resolveBookTransactionRunner(kernel, overrides),
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
