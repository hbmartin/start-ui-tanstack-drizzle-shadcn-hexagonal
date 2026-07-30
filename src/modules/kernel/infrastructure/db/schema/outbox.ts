import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, updatedAtColumn } from './common';

/**
 * Transactional outbox: domain events appended in the same transaction as the
 * state change they describe, drained asynchronously with
 * `FOR UPDATE SKIP LOCKED` (see `OutboxRepository`).
 */
export const outbox = pgTable(
  'outbox',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    type: text('type').notNull(),
    aggregateType: text('aggregateType').notNull(),
    aggregateId: text('aggregateId').notNull(),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    deployTarget: text('deployTarget'),
    status: text('status').default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    availableAt: timestamp('availableAt', { precision: 3, mode: 'date' })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp('publishedAt', { precision: 3, mode: 'date' }),
    lastError: text('lastError'),
    dedupeKey: text('dedupeKey'),
  },
  (table) => [
    index('outbox_status_available_at_idx').on(table.status, table.availableAt),
    uniqueIndex('outbox_dedupe_key_key')
      .on(table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null`),
  ]
);
