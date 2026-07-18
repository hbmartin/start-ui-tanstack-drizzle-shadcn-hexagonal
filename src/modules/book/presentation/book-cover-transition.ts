import type { BookId } from '@/modules/kernel/domain/ids';

export const getBookCoverViewTransitionName = (bookId: BookId) =>
  `book-cover-${Array.from(bookId, (character) =>
    character.codePointAt(0)?.toString(36)
  ).join('-')}`;
