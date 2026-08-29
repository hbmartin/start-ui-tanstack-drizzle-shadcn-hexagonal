import { Result } from '@bloodyowl/boxed';
import { z } from 'zod';

import type { GenreColor, GenreName } from '@/modules/genre';
import {
  type BookCoverObjectKey,
  type BookId,
  type GenreId,
  IdValidationError,
  type ParseResult,
} from '@/modules/kernel';

import {
  BOOK_AUTHOR_MAX_LENGTH,
  BOOK_PUBLISHER_MAX_LENGTH,
  BOOK_TITLE_MAX_LENGTH,
} from './book-policy';

const createBookTitleSchema = () =>
  z.string().trim().min(1).max(BOOK_TITLE_MAX_LENGTH).brand<'BookTitle'>();

const createBookAuthorSchema = () =>
  z.string().trim().min(1).max(BOOK_AUTHOR_MAX_LENGTH).brand<'BookAuthor'>();

const createPublisherNameSchema = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(BOOK_PUBLISHER_MAX_LENGTH)
    .brand<'PublisherName'>();

const zBookTitleSchema = createBookTitleSchema();
const zBookAuthorSchema = createBookAuthorSchema();
const zPublisherNameSchema = createPublisherNameSchema();

export type BookTitle = z.infer<typeof zBookTitleSchema>;
export type BookAuthor = z.infer<typeof zBookAuthorSchema>;
export type PublisherName = z.infer<typeof zPublisherNameSchema>;

export const zBookTitle = createBookTitleSchema;
export const zBookAuthor = createBookAuthorSchema;
export const zPublisherName = createPublisherNameSchema;

const parseBookString = <TSchema extends z.ZodType>(
  schema: TSchema,
  value: string,
  typeName: string
): ParseResult<z.output<TSchema>> => {
  const result = schema.safeParse(value);
  if (!result.success) {
    return Result.Error(
      new IdValidationError(typeName, value, `${typeName} is invalid`)
    );
  }
  return Result.Ok(result.data);
};

export const toBookTitle = (value: string): ParseResult<BookTitle> =>
  parseBookString(zBookTitleSchema, value, 'BookTitle');
export const toBookAuthor = (value: string): ParseResult<BookAuthor> =>
  parseBookString(zBookAuthorSchema, value, 'BookAuthor');
export const toPublisherName = (value: string): ParseResult<PublisherName> =>
  parseBookString(zPublisherNameSchema, value, 'PublisherName');

export type BookGenreSummary = {
  id: GenreId;
  name: GenreName;
  color: GenreColor;
  createdAt: Date;
  updatedAt: Date;
};

export type Book = {
  id: BookId;
  title: BookTitle;
  author: BookAuthor;
  genreId: GenreId;
  genre: BookGenreSummary | null;
  publisher: PublisherName | null;
  coverId: BookCoverObjectKey | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BookWriteInput = {
  title: BookTitle;
  author: BookAuthor;
  genreId: GenreId;
  publisher?: PublisherName | null;
  coverId?: BookCoverObjectKey | null;
};

export type BookListPage = {
  items: Book[];
  nextCursor?: BookId;
  total: number;
};

export function normalizeBookWriteInput(input: BookWriteInput): BookWriteInput {
  return {
    title: input.title,
    author: input.author,
    genreId: input.genreId,
    publisher: input.publisher ?? null,
    coverId: input.coverId ?? null,
  };
}
