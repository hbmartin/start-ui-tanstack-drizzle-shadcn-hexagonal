import { toProfileId, toProfileName } from '@/modules/profile';
import { toBookAuthor, toBookTitle, toPublisherName } from '@/modules/book';
import { toGenreColor, toGenreName } from '@/modules/genre';
import { unwrapParseResult } from '@/modules/kernel/testing';
import { toUserDisplayName } from '@/modules/user';

export const testProfileName = (value: string) =>
  unwrapParseResult(toProfileName(value));

export const testProfileId = (value: string) =>
  unwrapParseResult(toProfileId(value));

export const testBookTitle = (value: string) =>
  unwrapParseResult(toBookTitle(value));

export const testBookAuthor = (value: string) =>
  unwrapParseResult(toBookAuthor(value));

export const testPublisherName = (value: string) =>
  unwrapParseResult(toPublisherName(value));

export const testGenreName = (value: string) =>
  unwrapParseResult(toGenreName(value));

export const testGenreColor = (value: string) =>
  unwrapParseResult(toGenreColor(value));

export const testUserDisplayName = (value: string) =>
  unwrapParseResult(toUserDisplayName(value));
