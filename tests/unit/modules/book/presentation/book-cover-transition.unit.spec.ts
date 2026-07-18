import { describe, expect, it } from 'vitest';

import { getBookCoverViewTransitionName } from '@/modules/book/presentation/book-cover-transition';
import { toBookId, unwrapParseResult } from '@/modules/kernel/testing';

describe('getBookCoverViewTransitionName', () => {
  it('returns a stable CSS identifier for the complete book id', () => {
    const bookId = unwrapParseResult(toBookId('book / one (first)'));

    expect(getBookCoverViewTransitionName(bookId)).toBe(
      getBookCoverViewTransitionName(bookId)
    );
    expect(getBookCoverViewTransitionName(bookId)).toMatch(
      /^book-cover-[a-z\d-]+$/
    );
  });

  it('does not collapse distinct punctuation into the same name', () => {
    const slashId = unwrapParseResult(toBookId('book/a'));
    const dashId = unwrapParseResult(toBookId('book-a'));

    expect(getBookCoverViewTransitionName(slashId)).not.toBe(
      getBookCoverViewTransitionName(dashId)
    );
  });
});
