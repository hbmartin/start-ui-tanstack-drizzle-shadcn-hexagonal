import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';
import { z } from 'zod';

import { IdValidationError } from './errors/id-validation-error';

type InternalBrand<TValue, TBrand extends string> = TValue & {
  readonly __brand: TBrand;
};

const zBrandedNonEmptyString = <TBrand extends string>() =>
  z.string().trim().min(1).brand<TBrand>();

// TypeScript instantiation aliases keep one direct, statically provable
// constructor while every call still returns a fresh mutable Zod instance.
export const zUserId = zBrandedNonEmptyString<'UserId'>;
export const zBookId = zBrandedNonEmptyString<'BookId'>;
export const zGenreId = zBrandedNonEmptyString<'GenreId'>;
export const zSessionId = zBrandedNonEmptyString<'SessionId'>;
export const zScopeKey = zBrandedNonEmptyString<'ScopeKey'>;
export const zAuthorId = zBrandedNonEmptyString<'AuthorId'>;
export const zPublisherId = zBrandedNonEmptyString<'PublisherId'>;
export const zBookCoverObjectKey = zBrandedNonEmptyString<'BookCoverObjectKey'>;
export const zEmailStatusId = zBrandedNonEmptyString<'EmailStatusId'>;
export const zEmailProviderMessageId =
  zBrandedNonEmptyString<'EmailProviderMessageId'>;
export const zEmailIdempotencyKey =
  zBrandedNonEmptyString<'EmailIdempotencyKey'>;
export const zEmailWebhookEventId =
  zBrandedNonEmptyString<'EmailWebhookEventId'>;
export const zEmailRecipientList = zBrandedNonEmptyString<'EmailRecipientList'>;
export const zOtpCode = () => z.string().trim().length(6).brand<'OtpCode'>();
export const zLanguageCode = zBrandedNonEmptyString<'LanguageCode'>;
export const zEmailAddress = () =>
  z.string().trim().pipe(z.email()).brand<'EmailAddress'>();

const zUserIdSchema = zUserId();
const zBookIdSchema = zBookId();
const zGenreIdSchema = zGenreId();
const zSessionIdSchema = zSessionId();
const zScopeKeySchema = zScopeKey();
const zAuthorIdSchema = zAuthorId();
const zPublisherIdSchema = zPublisherId();
const zBookCoverObjectKeySchema = zBookCoverObjectKey();
const zEmailStatusIdSchema = zEmailStatusId();
const zEmailProviderMessageIdSchema = zEmailProviderMessageId();
const zEmailIdempotencyKeySchema = zEmailIdempotencyKey();
const zEmailWebhookEventIdSchema = zEmailWebhookEventId();
const zEmailRecipientListSchema = zEmailRecipientList();
const zOtpCodeSchema = zOtpCode();
const zLanguageCodeSchema = zLanguageCode();
const zEmailAddressSchema = zEmailAddress();

export type UserId = z.infer<typeof zUserIdSchema>;
export type BookId = z.infer<typeof zBookIdSchema>;
export type GenreId = z.infer<typeof zGenreIdSchema>;
export type SessionId = z.infer<typeof zSessionIdSchema>;
export type AuthSessionId = SessionId;
export type ScopeKey = z.infer<typeof zScopeKeySchema>;
export type AuthorId = z.infer<typeof zAuthorIdSchema>;
export type PublisherId = z.infer<typeof zPublisherIdSchema>;
export type BookCoverObjectKey = z.infer<typeof zBookCoverObjectKeySchema>;
export type EmailStatusId = z.infer<typeof zEmailStatusIdSchema>;
export type EmailProviderMessageId = z.infer<
  typeof zEmailProviderMessageIdSchema
>;
export type EmailIdempotencyKey = z.infer<typeof zEmailIdempotencyKeySchema>;
export type EmailWebhookEventId = z.infer<typeof zEmailWebhookEventIdSchema>;
export type EmailRecipientList = z.infer<typeof zEmailRecipientListSchema>;
export type OtpCode = z.infer<typeof zOtpCodeSchema>;
export type LanguageCode = z.infer<typeof zLanguageCodeSchema>;
export type EmailAddress = z.infer<typeof zEmailAddressSchema>;

export type GeneratedId = InternalBrand<string, 'GeneratedId'>;
export type RequestId = InternalBrand<string, 'RequestId'>;
export type CorrelationId = InternalBrand<string, 'CorrelationId'>;
export type CacheKey = InternalBrand<string, 'CacheKey'>;

export type ParseResult<TValue> = BoxedResult<TValue, IdValidationError>;

const ensureNonEmptyId = (
  value: string,
  typeName: string
): ParseResult<string> => {
  const trimmed = value.trim();
  if (!trimmed) {
    return Result.Error(new IdValidationError(typeName, value));
  }
  return Result.Ok(trimmed);
};

const parseBrandedString = <TSchema extends z.ZodType>(
  schema: TSchema,
  value: string,
  typeName: string,
  message?: string
): ParseResult<z.output<TSchema>> => {
  const result = schema.safeParse(value);
  if (!result.success) {
    return Result.Error(new IdValidationError(typeName, value, message));
  }
  return Result.Ok(result.data);
};

export const toUserId = (value: string): ParseResult<UserId> =>
  parseBrandedString(zUserIdSchema, value, 'UserId');
export const toBookId = (value: string): ParseResult<BookId> =>
  parseBrandedString(zBookIdSchema, value, 'BookId');
export const toGenreId = (value: string): ParseResult<GenreId> =>
  parseBrandedString(zGenreIdSchema, value, 'GenreId');
export const toSessionId = (value: string): ParseResult<SessionId> =>
  parseBrandedString(zSessionIdSchema, value, 'SessionId');
export const toScopeKey = (value: string): ParseResult<ScopeKey> =>
  parseBrandedString(zScopeKeySchema, value, 'ScopeKey');
export const toAuthorId = (value: string): ParseResult<AuthorId> =>
  parseBrandedString(zAuthorIdSchema, value, 'AuthorId');
export const toPublisherId = (value: string): ParseResult<PublisherId> =>
  parseBrandedString(zPublisherIdSchema, value, 'PublisherId');
export const toBookCoverObjectKey = (
  value: string
): ParseResult<BookCoverObjectKey> =>
  parseBrandedString(zBookCoverObjectKeySchema, value, 'BookCoverObjectKey');
export const toEmailStatusId = (value: string): ParseResult<EmailStatusId> =>
  parseBrandedString(zEmailStatusIdSchema, value, 'EmailStatusId');
export const toEmailProviderMessageId = (
  value: string
): ParseResult<EmailProviderMessageId> =>
  parseBrandedString(
    zEmailProviderMessageIdSchema,
    value,
    'EmailProviderMessageId'
  );
export const toEmailIdempotencyKey = (
  value: string
): ParseResult<EmailIdempotencyKey> =>
  parseBrandedString(zEmailIdempotencyKeySchema, value, 'EmailIdempotencyKey');
export const toEmailWebhookEventId = (
  value: string
): ParseResult<EmailWebhookEventId> =>
  parseBrandedString(zEmailWebhookEventIdSchema, value, 'EmailWebhookEventId');
export const toEmailRecipientList = (
  value: string
): ParseResult<EmailRecipientList> =>
  parseBrandedString(zEmailRecipientListSchema, value, 'EmailRecipientList');
export const toOtpCode = (value: string): ParseResult<OtpCode> =>
  parseBrandedString(zOtpCodeSchema, value, 'OtpCode', 'OtpCode is invalid');
export const toLanguageCode = (value: string): ParseResult<LanguageCode> =>
  parseBrandedString(zLanguageCodeSchema, value, 'LanguageCode');
export const toEmailAddress = (value: string): ParseResult<EmailAddress> =>
  parseBrandedString(
    zEmailAddressSchema,
    value,
    'EmailAddress',
    'EmailAddress is invalid'
  );

export const toGeneratedId = (value: string): ParseResult<GeneratedId> => {
  const result = ensureNonEmptyId(value, 'GeneratedId');
  return result.isError()
    ? Result.Error(result.getError())
    : Result.Ok(result.get() as GeneratedId);
};
export const toRequestId = (value: string): ParseResult<RequestId> => {
  const result = ensureNonEmptyId(value, 'RequestId');
  return result.isError()
    ? Result.Error(result.getError())
    : Result.Ok(result.get() as RequestId);
};
export const toCorrelationId = (value: string): ParseResult<CorrelationId> => {
  const result = ensureNonEmptyId(value, 'CorrelationId');
  return result.isError()
    ? Result.Error(result.getError())
    : Result.Ok(result.get() as CorrelationId);
};
export const toCacheKey = (value: string): ParseResult<CacheKey> => {
  const result = ensureNonEmptyId(value, 'CacheKey');
  return result.isError()
    ? Result.Error(result.getError())
    : Result.Ok(result.get() as CacheKey);
};
