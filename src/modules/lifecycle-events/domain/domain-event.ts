import { z } from 'zod';

/**
 * Typed registry of domain lifecycle events carried through the transactional
 * outbox. Emitting modules append plain envelopes via the kernel
 * `OutboxRepository` port (they do not depend on this module); consumers use
 * this registry to narrow and validate payloads.
 */
export const BOOK_CREATED_EVENT_TYPE = 'book.created';

export const zBookCreatedPayload = z.object({
  bookId: z.string().min(1),
  title: z.string(),
  author: z.string(),
});

export type BookCreatedPayload = z.infer<typeof zBookCreatedPayload>;

export const domainEventPayloadSchemas = {
  [BOOK_CREATED_EVENT_TYPE]: zBookCreatedPayload,
} as const;

export type DomainEventType = keyof typeof domainEventPayloadSchemas;

export type DomainEventPayload<TType extends DomainEventType> = z.infer<
  (typeof domainEventPayloadSchemas)[TType]
>;

export const isKnownDomainEventType = (type: string): type is DomainEventType =>
  Object.hasOwn(domainEventPayloadSchemas, type);

export type ParsedDomainEventOutcome<TType extends DomainEventType> =
  | { type: 'domain_event_parsed'; payload: DomainEventPayload<TType> }
  | { type: 'domain_event_payload_invalid' };

export const parseDomainEventPayload = <TType extends DomainEventType>(
  eventType: TType,
  payload: unknown
): ParsedDomainEventOutcome<TType> => {
  const parsed = domainEventPayloadSchemas[eventType].safeParse(payload);
  if (!parsed.success) return { type: 'domain_event_payload_invalid' };
  return {
    type: 'domain_event_parsed',
    payload: parsed.data,
  };
};
