import { z } from 'zod';

import type { ProtectedContext } from '@/modules/auth/backend';
import type { BookUseCases } from '@/modules/book';
import {
  zBookCoverObjectKey,
  zBookId,
  zGenreId,
} from '@/modules/kernel/domain/ids';
import {
  type OutcomeHandlerConfig,
  unwrapApplicationResult,
} from '@/modules/kernel/transport/tanstack/result-mapper';

import type {
  BookCreateOutcome,
  BookDeleteOutcome,
  BookGetOutcome,
  BookListOutcome,
  BookUpdateOutcome,
} from '../../application/use-cases/types';
import {
  type Book,
  type BookListPage,
  type PublisherName,
  zBookAuthor,
  zBookTitle,
  zPublisherName,
} from '../../domain/book';

export const zGetAllInput = () =>
  z
    .object({
      cursor: zBookId().optional(),
      limit: z.coerce.number().int().min(1).max(100).prefault(20),
      searchTerm: z.string().trim().optional(),
    })
    .prefault({});

export const zGetByIdInput = () => z.object({ id: zBookId() });

const zBookCoverInput = () =>
  z
    .union([z.literal(''), zBookCoverObjectKey()])
    .nullish()
    .transform((value) => value || null);

const normalizePublisherName = (
  publisher: '' | PublisherName | null | undefined
): PublisherName | null => publisher || null;

const zOptionalPublisherName = () =>
  z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z.union([z.literal(''), zPublisherName()]).nullish()
  );

const normalizeBookWriteInputPayload = <
  TInput extends { publisher?: '' | PublisherName | null },
>(
  book: TInput
) => ({
  ...book,
  publisher: normalizePublisherName(book.publisher),
});

const zBookWriteInputBase = () =>
  z.object({
    title: zBookTitle(),
    author: zBookAuthor(),
    genreId: zGenreId(),
    publisher: zOptionalPublisherName(),
    coverId: zBookCoverInput(),
  });

const zBookWriteInput = () =>
  zBookWriteInputBase().transform(normalizeBookWriteInputPayload);

export const zCreateInput = () => zBookWriteInput();
export const zUpdateByIdInput = () =>
  zBookWriteInputBase()
    .extend({ id: zBookId() })
    .transform(normalizeBookWriteInputPayload);
export const zDeleteByIdInput = () => z.object({ id: zBookId() });

type BookHandlerDeps = {
  getUseCases: (ctx: ProtectedContext) => BookUseCases;
};

const bookDuplicateConfig = {
  book_duplicate: {
    code: 'CONFLICT',
    reason: 'already_exists',
    target: 'book.title',
  },
} as const;

const bookCoverUnownedConfig = {
  book_cover_unowned: {
    code: 'BAD_REQUEST',
    reason: 'upload_invalid',
    target: 'book.cover',
  },
} as const;

const bookListConfig = {
  book_forbidden: 'FORBIDDEN',
  book_listed: (outcome) => outcome.page,
} as const satisfies OutcomeHandlerConfig<BookListOutcome, BookListPage>;

const bookGetConfig = {
  book_forbidden: 'FORBIDDEN',
  book_found: (outcome) => outcome.book,
  book_not_found: {
    code: 'NOT_FOUND',
    reason: 'not_found',
    target: 'book',
  },
} as const satisfies OutcomeHandlerConfig<BookGetOutcome, Book>;

const bookCreateConfig = {
  book_created: (outcome) => outcome.book,
  book_forbidden: 'FORBIDDEN',
  ...bookDuplicateConfig,
  ...bookCoverUnownedConfig,
} as const satisfies OutcomeHandlerConfig<BookCreateOutcome, Book>;

const bookUpdateConfig = {
  book_forbidden: 'FORBIDDEN',
  book_not_found: {
    code: 'NOT_FOUND',
    reason: 'not_found',
    target: 'book',
  },
  book_updated: (outcome) => outcome.book,
  ...bookDuplicateConfig,
  ...bookCoverUnownedConfig,
} as const satisfies OutcomeHandlerConfig<BookUpdateOutcome, Book>;

const bookDeleteConfig = {
  book_deleted: () => undefined,
  book_forbidden: 'FORBIDDEN',
  book_not_found: {
    code: 'NOT_FOUND',
    reason: 'not_found',
    target: 'book',
  },
} as const satisfies OutcomeHandlerConfig<BookDeleteOutcome, void>;

export const createBookHandlers = ({ getUseCases }: BookHandlerDeps) => {
  const getAll = async (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zGetAllInput>>
  ) => {
    return unwrapApplicationResult(
      getUseCases(ctx).list({
        currentUserId: ctx.scope.userId,
        cursor: data.cursor,
        limit: data.limit,
        searchTerm: data.searchTerm ?? '',
      }),
      bookListConfig
    );
  };

  const getById = async (
    ctx: ProtectedContext,
    data: z.infer<ReturnType<typeof zGetByIdInput>>
  ) => {
    return unwrapApplicationResult(
      getUseCases(ctx).get({
        currentUserId: ctx.scope.userId,
        id: data.id,
      }),
      bookGetConfig
    );
  };

  const create = async (
    ctx: ProtectedContext,
    data: z.infer<ReturnType<typeof zCreateInput>>
  ) => {
    return unwrapApplicationResult(
      getUseCases(ctx).create({
        currentUserId: ctx.scope.userId,
        book: {
          title: data.title,
          author: data.author,
          genreId: data.genreId,
          publisher: data.publisher,
          coverId: data.coverId,
        },
      }),
      bookCreateConfig
    );
  };

  const updateById = async (
    ctx: ProtectedContext,
    data: z.infer<ReturnType<typeof zUpdateByIdInput>>
  ) => {
    return unwrapApplicationResult(
      getUseCases(ctx).update({
        currentUserId: ctx.scope.userId,
        id: data.id,
        book: {
          title: data.title,
          author: data.author,
          genreId: data.genreId,
          publisher: data.publisher,
          coverId: data.coverId,
        },
      }),
      bookUpdateConfig
    );
  };

  const deleteById = async (
    ctx: ProtectedContext,
    data: z.infer<ReturnType<typeof zDeleteByIdInput>>
  ) => {
    return unwrapApplicationResult(
      getUseCases(ctx).delete({
        correlationId: ctx.correlationId,
        currentUserId: ctx.scope.userId,
        id: data.id,
      }),
      bookDeleteConfig
    );
  };

  return {
    getAll,
    getById,
    create,
    updateById,
    deleteById,
  };
};

export type BookHandlers = ReturnType<typeof createBookHandlers>;
