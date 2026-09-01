import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import {
  createdAtColumn,
  idColumn,
} from '@/modules/kernel/infrastructure/db/schema/common';

import type {
  AuditEventClass,
  AuditEventInput,
  AuditPersistencePolicy,
  AuditRetentionClass,
} from '../../domain/audit-event';

export const auditEvent = pgTable(
  'audit_event',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    occurredAt: timestamp('occurredAt', {
      precision: 3,
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    type: text('type').$type<AuditEventInput['type']>().notNull(),
    eventClass: text('eventClass').$type<AuditEventClass>().notNull(),
    persistence: text('persistence').$type<AuditPersistencePolicy>().notNull(),
    actorKind: text('actorKind').notNull(),
    actorId: text('actorId'),
    subjectKind: text('subjectKind'),
    subjectId: text('subjectId'),
    correlationId: text('correlationId').notNull(),
    metadata: jsonb('metadata').$type<AuditEventInput['metadata']>().notNull(),
    retentionClass: text('retentionClass')
      .$type<AuditRetentionClass>()
      .notNull(),
    retainUntil: timestamp('retainUntil', {
      precision: 3,
      mode: 'date',
      withTimezone: true,
    }),
    legalHold: boolean('legalHold').notNull(),
  },
  (table) => [
    check(
      'audit_event_definition_check',
      sql`((${table.type}, ${table.eventClass}, ${table.persistence}, ${table.retentionClass}) in (
        ('administration.user-deleted', 'administration', 'required', 'administrative'),
        ('authentication.failed', 'authentication', 'required', 'security'),
        ('authentication.signed-in', 'authentication', 'required', 'security'),
        ('authentication.signed-out', 'authentication', 'required', 'security'),
        ('authorization.role-changed', 'authorization', 'required', 'security'),
        ('data.book-deleted', 'data', 'required', 'standard'),
        ('profile.updated', 'profile', 'best-effort', 'standard'),
        ('session.revoked', 'authentication', 'required', 'security')
      )) is true`
    ),
    check(
      'audit_event_actor_check',
      sql`((
        (${table.actorKind} = 'anonymous' and ${table.actorId} is null) or
        (${table.actorKind} = 'user' and ${table.actorId} is not null) or
        (${table.actorKind} = 'system' and ${table.actorId} in ('application', 'auth-provider'))
      )) is true`
    ),
    check(
      'audit_event_subject_pair_check',
      sql`((
        (${table.subjectKind} is null and ${table.subjectId} is null) or
        (${table.subjectKind} in ('application', 'auth-identity', 'book', 'invite', 'profile', 'session', 'user') and ${table.subjectId} is not null)
      )) is true`
    ),
    check(
      'audit_event_identifier_check',
      sql`(${table.correlationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and (${table.actorId} is null or ${table.actorId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$')
        and (${table.subjectId} is null or ${table.subjectId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$')) is true`
    ),
    check(
      'audit_event_metadata_object_check',
      sql`(jsonb_typeof(${table.metadata}) = 'object') is true`
    ),
    check(
      'audit_event_retention_check',
      sql`(${table.retainUntil} is not null and ${table.retainUntil} > ${table.occurredAt}) is true`
    ),
    check(
      'audit_event_semantics_check',
      sql`((
        (${table.type} = 'administration.user-deleted'
          and ${table.actorKind} = 'user' and ${table.subjectKind} = 'user'
          and ${table.metadata}->>'reason' in ('administrator', 'self-service')
          and ${table.metadata} - array['reason']::text[] = '{}'::jsonb
          and (${table.metadata}->>'reason' <> 'self-service' or ${table.actorId} = ${table.subjectId})) or
        (${table.type} = 'authentication.failed'
          and ${table.metadata}->>'method' in ('oauth', 'otp', 'password')
          and ${table.metadata}->>'reason' in ('invalid-credential', 'locked', 'rate-limited', 'unknown-user')
          and ${table.metadata} - array['method', 'reason']::text[] = '{}'::jsonb
          and ((${table.actorKind} = 'anonymous' and ${table.subjectKind} is null)
            or (${table.actorKind} = 'user' and ${table.subjectKind} = 'user'
              and ${table.actorId} = ${table.subjectId}
              and ${table.metadata}->>'reason' <> 'unknown-user'))) or
        (${table.type} = 'authentication.signed-in'
          and ${table.actorKind} = 'user' and ${table.subjectKind} = 'user'
          and ${table.actorId} = ${table.subjectId}
          and ${table.metadata}->>'method' in ('oauth', 'otp', 'password')
          and ${table.metadata} - array['method']::text[] = '{}'::jsonb) or
        (${table.type} = 'authentication.signed-out'
          and ${table.actorKind} = 'user'
          and ${table.metadata} - array['scope']::text[] = '{}'::jsonb
          and ((${table.metadata}->>'scope' = 'current-session' and ${table.subjectKind} = 'session')
            or (${table.metadata}->>'scope' = 'all' and ${table.subjectKind} = 'user' and ${table.actorId} = ${table.subjectId}))) or
        (${table.type} = 'authorization.role-changed'
          and ${table.actorKind} = 'user' and ${table.subjectKind} = 'user'
          and ${table.metadata}->>'from' in ('admin', 'user')
          and ${table.metadata}->>'to' in ('admin', 'user')
          and ${table.metadata}->>'from' <> ${table.metadata}->>'to'
          and ${table.metadata} - array['from', 'to']::text[] = '{}'::jsonb) or
        (${table.type} = 'data.book-deleted'
          and ${table.actorKind} = 'user' and ${table.subjectKind} = 'book'
          and ${table.metadata} = '{}'::jsonb) or
        (${table.type} = 'profile.updated'
          and ${table.actorKind} = 'user' and ${table.subjectKind} = 'profile'
          and jsonb_typeof(${table.metadata}->'fields') = 'array'
          and ${table.metadata} - array['fields']::text[] = '{}'::jsonb) or
        (${table.type} = 'session.revoked'
          and ${table.actorKind} in ('system', 'user')
          and ${table.metadata}->>'reason' in ('administrator', 'role-change', 'user-request')
          and ${table.metadata} - array['reason', 'scope']::text[] = '{}'::jsonb
          and ((${table.metadata}->>'scope' = 'single' and ${table.subjectKind} = 'session')
            or (${table.metadata}->>'scope' = 'all' and ${table.subjectKind} = 'user')))
      )) is true`
    ),
    index('audit_event_occurred_at_idx').on(table.occurredAt),
    index('audit_event_correlation_id_idx').on(table.correlationId),
    index('audit_event_subject_idx').on(table.subjectKind, table.subjectId),
    index('audit_event_retention_idx').on(table.legalHold, table.retainUntil),
  ]
);
