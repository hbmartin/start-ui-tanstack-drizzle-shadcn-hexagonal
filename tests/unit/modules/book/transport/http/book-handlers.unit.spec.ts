import { Result } from '@bloodyowl/boxed';
import { createAuthenticatedContext } from '@tests/server/test-utils';
import { testBookAuthor, testBookTitle } from '@tests/support/branded-values';
import { fc, PROPERTY_DEFAULTS, test } from '@tests/support/property-testing';
import { describe, expect, it, vi } from 'vitest';

import { BOOK_PUBLISHER_MAX_LENGTH } from '@/modules/book';
import {
  createBookHandlers,
  zCreateInput,
  zDeleteByIdInput,
  zGetAllInput,
} from '@/modules/book/transport/http/book-handlers';
import { toBookId, toGenreId } from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';

const validPaginationLimit = fc.integer({ max: 100, min: 1 });
const invalidPaginationLimit = fc.oneof(
  fc.integer({ max: 0, min: -1_000 }),
  fc.integer({ max: 1_000, min: 101 }),
  fc.integer({ max: 99, min: 1 }).map((value) => value + 0.5),
  fc.constantFrom('NaN', 'abc', '1.5')
);
const searchTerm = fc.string({ maxLength: 80 });

describe('book HTTP transport handlers', () => {
  it('maps list input and protected scope to the list use case', async () => {
    const ctx = createAuthenticatedContext();
    const list = vi.fn(async () =>
      Result.Ok({
        type: 'book_listed' as const,
        page: { items: [], total: 0 },
      })
    );
    const handlers = createBookHandlers({
      getUseCases: () => ({ list }) as ExplicitAny,
    });

    await expect(
      handlers.getAll(
        ctx,
        zGetAllInput().parse({
          cursor: 'book-1',
          limit: '7',
          searchTerm: ' dune ',
        })
      )
    ).resolves.toEqual({ items: [], total: 0 });

    expect(list).toHaveBeenCalledWith({
      currentUserId: ctx.scope.userId,
      cursor: unwrapParseResult(toBookId('book-1')),
      limit: 7,
      searchTerm: 'dune',
    });
  });

  it('maps create input into domain write values', async () => {
    const ctx = createAuthenticatedContext();
    const create = vi.fn(async () =>
      Result.Ok({
        type: 'book_created' as const,
        book: { id: unwrapParseResult(toBookId('book-1')) },
      })
    );
    const handlers = createBookHandlers({
      getUseCases: () => ({ create }) as ExplicitAny,
    });

    await expect(
      handlers.create(
        ctx,
        zCreateInput().parse({
          title: testBookTitle('Dune'),
          author: testBookAuthor('Frank Herbert'),
          genreId: 'genre-1',
          publisher: null,
          coverId: 'cover-1',
        })
      )
    ).resolves.toEqual({ id: unwrapParseResult(toBookId('book-1')) });

    expect(create).toHaveBeenCalledWith({
      currentUserId: ctx.scope.userId,
      book: {
        title: testBookTitle('Dune'),
        author: testBookAuthor('Frank Herbert'),
        genreId: unwrapParseResult(toGenreId('genre-1')),
        publisher: null,
        coverId: 'cover-1',
      },
    });
  });

  it('passes request correlation into audited deletion', async () => {
    const ctx = createAuthenticatedContext();
    const deleteBook = vi.fn(async () =>
      Result.Ok({ type: 'book_deleted' as const, deletedCoverId: null })
    );
    const handlers = createBookHandlers({
      getUseCases: () => ({ delete: deleteBook }) as ExplicitAny,
    });

    await expect(
      handlers.deleteById(ctx, zDeleteByIdInput().parse({ id: 'book-1' }))
    ).resolves.toBeUndefined();

    expect(deleteBook).toHaveBeenCalledWith({
      correlationId: ctx.correlationId,
      currentUserId: ctx.scope.userId,
      id: unwrapParseResult(toBookId('book-1')),
    });
  });

  it('trims publisher before enforcing its max length', () => {
    const publisher = 'P'.repeat(BOOK_PUBLISHER_MAX_LENGTH);

    expect(
      zCreateInput().parse({
        title: testBookTitle('Dune'),
        author: testBookAuthor('Frank Herbert'),
        genreId: 'genre-1',
        publisher: ` ${publisher} `,
      }).publisher
    ).toBe(publisher);
  });

  it('normalizes whitespace-only optional publisher input to null', () => {
    expect(
      zCreateInput().parse({
        title: testBookTitle('Dune'),
        author: testBookAuthor('Frank Herbert'),
        genreId: 'genre-1',
        publisher: '   ',
      }).publisher
    ).toBeNull();
  });

  test.prop([validPaginationLimit, fc.boolean()], PROPERTY_DEFAULTS)(
    'parses generated valid list pagination limits',
    (limit, asString) => {
      expect(
        zGetAllInput().parse({ limit: asString ? String(limit) : limit }).limit
      ).toBe(limit);
    }
  );

  it('defaults missing list pagination limits', () => {
    expect(zGetAllInput().parse({}).limit).toBe(20);
  });

  test.prop([invalidPaginationLimit], PROPERTY_DEFAULTS)(
    'rejects generated invalid list pagination limits',
    (limit) => {
      expect(() => zGetAllInput().parse({ limit })).toThrow();
    }
  );

  test.prop([searchTerm], PROPERTY_DEFAULTS)(
    'trims generated list search terms',
    (term) => {
      expect(
        zGetAllInput().parse({ searchTerm: ` \t${term}\n ` })
      ).toMatchObject({
        searchTerm: term.trim(),
      });
    }
  );
});
