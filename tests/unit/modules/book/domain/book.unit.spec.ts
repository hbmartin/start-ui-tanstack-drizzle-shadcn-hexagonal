import {
  testBookAuthor,
  testBookTitle,
  testPublisherName,
} from '@tests/support/branded-values';
import { fc, PROPERTY_DEFAULTS, test } from '@tests/support/property-testing';
import { describe, expect, it } from 'vitest';

import {
  normalizeBookWriteInput,
  zBookAuthor,
  zBookTitle,
  zPublisherName,
} from '@/modules/book/domain/book';
import { isDuplicateBookCandidate } from '@/modules/book/domain/book-policy';
import { toBookCoverObjectKey, toGenreId } from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';

const text = fc.string({ maxLength: 80 });
const nonBlankText = text.filter((value) => value.trim().length > 0);
const bookTitle = nonBlankText.map(testBookTitle);
const bookAuthor = nonBlankText.map(testBookAuthor);
const optionalPublisher = fc.option(nonBlankText.map(testPublisherName), {
  nil: undefined,
});
const genreId = nonBlankText.map((value) =>
  unwrapParseResult(toGenreId(value))
);
const coverId = fc.option(
  nonBlankText.map((value) => unwrapParseResult(toBookCoverObjectKey(value))),
  {
    nil: null,
  }
);
const duplicateText = fc.stringMatching(/^[a-z]{1,40}$/);

describe('book domain', () => {
  it('creates fresh book schemas for each consumer', () => {
    expect(zBookTitle()).not.toBe(zBookTitle());
    expect(zBookAuthor()).not.toBe(zBookAuthor());
    expect(zPublisherName()).not.toBe(zPublisherName());
  });

  it('normalizes writable book fields', () => {
    expect(
      normalizeBookWriteInput({
        title: testBookTitle(' Title '),
        author: testBookAuthor(' Author '),
        genreId: unwrapParseResult(toGenreId('genre-1')),
        publisher: testPublisherName(' Publisher '),
        coverId: unwrapParseResult(toBookCoverObjectKey(' cover ')),
      })
    ).toEqual({
      title: testBookTitle('Title'),
      author: testBookAuthor('Author'),
      genreId: 'genre-1',
      publisher: testPublisherName('Publisher'),
      coverId: 'cover',
    });
  });

  it('detects duplicate title and author candidates case-insensitively', () => {
    expect(
      isDuplicateBookCandidate(
        {
          title: testBookTitle('Dune'),
          author: testBookAuthor('Frank Herbert'),
        },
        {
          title: testBookTitle(' dune '),
          author: testBookAuthor('frank herbert'),
        }
      )
    ).toBe(true);
  });

  test.prop(
    [
      fc.record({
        title: bookTitle,
        author: bookAuthor,
        genreId,
        publisher: optionalPublisher,
        coverId,
      }),
    ],
    PROPERTY_DEFAULTS
  )('normalizes writable book fields for generated inputs', (input) => {
    expect(normalizeBookWriteInput(input)).toEqual({
      title: input.title,
      author: input.author,
      genreId: input.genreId,
      publisher: input.publisher ?? null,
      coverId: input.coverId ?? null,
    });
  });

  test.prop([duplicateText, duplicateText], PROPERTY_DEFAULTS)(
    'detects duplicate candidates by normalized title and author',
    (title, author) => {
      expect(
        isDuplicateBookCandidate(
          { title: testBookTitle(title), author: testBookAuthor(author) },
          {
            title: testBookTitle(` ${title.toUpperCase()} `),
            author: testBookAuthor(` ${author.toLowerCase()} `),
          }
        )
      ).toBe(true);
    }
  );
});
