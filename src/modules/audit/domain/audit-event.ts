import { Result } from '@bloodyowl/boxed';
import { z } from 'zod';

import { IdValidationError } from '@/modules/kernel/domain/errors/id-validation-error';
import type {
  CorrelationId,
  GeneratedId,
  ParseResult,
  UserId,
} from '@/modules/kernel/domain/ids';

export const auditEventTypes = [
  'authentication.failed',
  'authentication.signed-in',
  'authentication.signed-out',
  'authorization.role-changed',
  'administration.user-deleted',
  'data.book-deleted',
  'profile.updated',
  'session.revoked',
] as const;

export type AuditEventType = (typeof auditEventTypes)[number];

const auditEventClasses = [
  'administration',
  'authentication',
  'authorization',
  'data',
  'profile',
] as const;
export type AuditEventClass = (typeof auditEventClasses)[number];

export const auditRetentionClasses = [
  'administrative',
  'security',
  'standard',
] as const;
export type AuditRetentionClass = (typeof auditRetentionClasses)[number];

export type AuditPersistencePolicy = 'required' | 'best-effort';

export const auditEventDefinitions = {
  'administration.user-deleted': {
    eventClass: 'administration',
    persistence: 'required',
    retentionClass: 'administrative',
  },
  'authentication.failed': {
    eventClass: 'authentication',
    persistence: 'required',
    retentionClass: 'security',
  },
  'authentication.signed-in': {
    eventClass: 'authentication',
    persistence: 'required',
    retentionClass: 'security',
  },
  'authentication.signed-out': {
    eventClass: 'authentication',
    persistence: 'required',
    retentionClass: 'security',
  },
  'authorization.role-changed': {
    eventClass: 'authorization',
    persistence: 'required',
    retentionClass: 'security',
  },
  'data.book-deleted': {
    eventClass: 'data',
    persistence: 'required',
    retentionClass: 'standard',
  },
  'profile.updated': {
    eventClass: 'profile',
    persistence: 'best-effort',
    retentionClass: 'standard',
  },
  'session.revoked': {
    eventClass: 'authentication',
    persistence: 'required',
    retentionClass: 'security',
  },
} as const satisfies Record<
  AuditEventType,
  Readonly<{
    eventClass: AuditEventClass;
    persistence: AuditPersistencePolicy;
    retentionClass: AuditRetentionClass;
  }>
>;

export const auditSystemActors = ['application', 'auth-provider'] as const;
export type AuditSystemActor = (typeof auditSystemActors)[number];

export type AuditActor =
  | Readonly<{ kind: 'anonymous' }>
  | Readonly<{ kind: 'system'; name: AuditSystemActor }>
  | Readonly<{ kind: 'user'; userId: UserId }>;

export const auditSubjectKinds = [
  'application',
  'auth-identity',
  'book',
  'invite',
  'profile',
  'session',
  'user',
] as const;
export type AuditSubjectKind = (typeof auditSubjectKinds)[number];

declare const auditSubjectIdBrand: unique symbol;
export type AuditSubjectId<TKind extends AuditSubjectKind> = string & {
  readonly [auditSubjectIdBrand]: TKind;
};

export type AuditSubject<TKind extends AuditSubjectKind = AuditSubjectKind> =
  Readonly<{
    id: AuditSubjectId<TKind>;
    kind: TKind;
  }>;

const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const boundedIdentifier = z
  .string()
  .min(1)
  .max(256)
  .regex(safeIdentifierPattern);

export const toAuditSubjectId = <TKind extends AuditSubjectKind>(
  kind: TKind,
  value: string
): ParseResult<AuditSubjectId<TKind>> => {
  const result = boundedIdentifier.safeParse(value);
  return result.success
    ? Result.Ok(result.data as AuditSubjectId<TKind>)
    : Result.Error(new IdValidationError(`${kind}AuditSubjectId`, value));
};

type AuthenticationMethod = 'oauth' | 'otp' | 'password';
type NoAuditMetadata = Readonly<Record<string, never>>;

export type AuditEventMetadataMap = {
  'administration.user-deleted': Readonly<{
    reason: 'administrator' | 'self-service';
  }>;
  'authentication.failed': Readonly<{
    method: AuthenticationMethod;
    reason: 'invalid-credential' | 'locked' | 'rate-limited' | 'unknown-user';
  }>;
  'authentication.signed-in': Readonly<{ method: AuthenticationMethod }>;
  'authentication.signed-out': Readonly<{
    scope: 'current-session' | 'all';
  }>;
  'authorization.role-changed': Readonly<{
    from: 'admin' | 'user';
    to: 'admin' | 'user';
  }>;
  'data.book-deleted': NoAuditMetadata;
  'profile.updated': Readonly<{
    fields: readonly ('image' | 'name')[];
  }>;
  'session.revoked': Readonly<{
    reason: 'administrator' | 'role-change' | 'user-request';
    scope: 'all' | 'single';
  }>;
};

type UserActor = Extract<AuditActor, { kind: 'user' }>;
type SystemActor = Extract<AuditActor, { kind: 'system' }>;
type AnonymousActor = Extract<AuditActor, { kind: 'anonymous' }>;

type AuditEvent<
  TType extends AuditEventType,
  TActor extends AuditActor,
  TSubject extends AuditSubject | undefined,
  TMetadata extends AuditEventMetadataMap[TType],
> = Readonly<{
  actor: TActor;
  correlationId: CorrelationId;
  metadata: TMetadata;
  subject: TSubject;
  type: TType;
}>;

export type AuditEventInput =
  | AuditEvent<
      'administration.user-deleted',
      UserActor,
      AuditSubject<'user'>,
      AuditEventMetadataMap['administration.user-deleted']
    >
  | AuditEvent<
      'authentication.failed',
      AnonymousActor,
      undefined,
      AuditEventMetadataMap['authentication.failed']
    >
  | AuditEvent<
      'authentication.failed',
      UserActor,
      AuditSubject<'user'>,
      Omit<AuditEventMetadataMap['authentication.failed'], 'reason'> & {
        reason: Exclude<
          AuditEventMetadataMap['authentication.failed']['reason'],
          'unknown-user'
        >;
      }
    >
  | AuditEvent<
      'authentication.signed-in',
      UserActor,
      AuditSubject<'user'>,
      AuditEventMetadataMap['authentication.signed-in']
    >
  | AuditEvent<
      'authentication.signed-out',
      UserActor,
      AuditSubject<'session'>,
      AuditEventMetadataMap['authentication.signed-out'] & {
        scope: 'current-session';
      }
    >
  | AuditEvent<
      'authentication.signed-out',
      UserActor,
      AuditSubject<'user'>,
      AuditEventMetadataMap['authentication.signed-out'] & { scope: 'all' }
    >
  | AuditEvent<
      'authorization.role-changed',
      UserActor,
      AuditSubject<'user'>,
      AuditEventMetadataMap['authorization.role-changed']
    >
  | AuditEvent<
      'data.book-deleted',
      UserActor,
      AuditSubject<'book'>,
      AuditEventMetadataMap['data.book-deleted']
    >
  | AuditEvent<
      'profile.updated',
      UserActor,
      AuditSubject<'profile'>,
      AuditEventMetadataMap['profile.updated']
    >
  | AuditEvent<
      'session.revoked',
      UserActor | SystemActor,
      AuditSubject<'session'>,
      AuditEventMetadataMap['session.revoked'] & { scope: 'single' }
    >
  | AuditEvent<
      'session.revoked',
      UserActor | SystemActor,
      AuditSubject<'user'>,
      AuditEventMetadataMap['session.revoked'] & { scope: 'all' }
    >;

const zAuditEventIdSchema = boundedIdentifier.brand<'AuditEventId'>();
export type AuditEventId = z.infer<typeof zAuditEventIdSchema>;

export const toAuditEventId = (
  value: GeneratedId
): ParseResult<AuditEventId> => {
  const result = zAuditEventIdSchema.safeParse(value);
  if (!result.success) {
    return Result.Error(new IdValidationError('AuditEventId', value));
  }
  return Result.Ok(result.data);
};

const correlationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(safeIdentifierPattern);
const anonymousActorSchema = z.strictObject({ kind: z.literal('anonymous') });
const systemActorSchema = z.strictObject({
  kind: z.literal('system'),
  name: z.enum(auditSystemActors),
});
const userActorSchema = z.strictObject({
  kind: z.literal('user'),
  userId: boundedIdentifier,
});
const subjectSchema = <TKind extends AuditSubjectKind>(kind: TKind) =>
  z.strictObject({ id: boundedIdentifier, kind: z.literal(kind) });
const eventSchema = <
  TType extends AuditEventType,
  TActor extends z.ZodType,
  TSubject extends z.ZodType,
  TMetadata extends z.ZodType,
>(
  type: TType,
  actor: TActor,
  subject: TSubject,
  metadata: TMetadata
) =>
  z.strictObject({
    actor,
    correlationId: correlationIdSchema,
    metadata,
    subject,
    type: z.literal(type),
  });

const authenticationMethodSchema = z.enum(['oauth', 'otp', 'password']);
const knownAuthenticationFailureReasonSchema = z.enum([
  'invalid-credential',
  'locked',
  'rate-limited',
]);
const signedOutSchema = z.union([
  eventSchema(
    'authentication.signed-out',
    userActorSchema,
    subjectSchema('session'),
    z.strictObject({ scope: z.literal('current-session') })
  ),
  eventSchema(
    'authentication.signed-out',
    userActorSchema,
    subjectSchema('user'),
    z.strictObject({ scope: z.literal('all') })
  ).refine((event) => event.actor.userId === event.subject.id, {
    message:
      'All-session sign-out actor and subject must identify the same user',
    path: ['subject', 'id'],
  }),
]);
const revokedSchema = z.union([
  eventSchema(
    'session.revoked',
    z.union([userActorSchema, systemActorSchema]),
    subjectSchema('session'),
    z.strictObject({
      reason: z.enum(['administrator', 'role-change', 'user-request']),
      scope: z.literal('single'),
    })
  ),
  eventSchema(
    'session.revoked',
    z.union([userActorSchema, systemActorSchema]),
    subjectSchema('user'),
    z.strictObject({
      reason: z.enum(['administrator', 'role-change', 'user-request']),
      scope: z.literal('all'),
    })
  ),
]);

const eventSchemas = {
  'administration.user-deleted': eventSchema(
    'administration.user-deleted',
    userActorSchema,
    subjectSchema('user'),
    z.strictObject({ reason: z.enum(['administrator', 'self-service']) })
  ).refine(
    (event) =>
      event.metadata.reason !== 'self-service' ||
      event.actor.userId === event.subject.id,
    {
      message:
        'Self-service deletion actor and subject must identify the same user',
      path: ['subject', 'id'],
    }
  ),
  'authentication.failed': z.union([
    eventSchema(
      'authentication.failed',
      anonymousActorSchema,
      z.undefined(),
      z.strictObject({
        method: authenticationMethodSchema,
        reason: z.enum([
          'invalid-credential',
          'locked',
          'rate-limited',
          'unknown-user',
        ]),
      })
    ),
    eventSchema(
      'authentication.failed',
      userActorSchema,
      subjectSchema('user'),
      z.strictObject({
        method: authenticationMethodSchema,
        reason: knownAuthenticationFailureReasonSchema,
      })
    ).refine((event) => event.actor.userId === event.subject.id, {
      message:
        'Known authentication failure actor and subject must identify the same user',
      path: ['subject', 'id'],
    }),
  ]),
  'authentication.signed-in': eventSchema(
    'authentication.signed-in',
    userActorSchema,
    subjectSchema('user'),
    z.strictObject({ method: authenticationMethodSchema })
  ).refine((event) => event.actor.userId === event.subject.id, {
    message: 'Sign-in actor and subject must identify the same user',
    path: ['subject', 'id'],
  }),
  'authentication.signed-out': signedOutSchema,
  'authorization.role-changed': eventSchema(
    'authorization.role-changed',
    userActorSchema,
    subjectSchema('user'),
    z.strictObject({
      from: z.enum(['admin', 'user']),
      to: z.enum(['admin', 'user']),
    })
  ).refine((event) => event.metadata.from !== event.metadata.to, {
    message: 'Role change must change the role',
    path: ['metadata', 'to'],
  }),
  'data.book-deleted': eventSchema(
    'data.book-deleted',
    userActorSchema,
    subjectSchema('book'),
    z.strictObject({})
  ),
  'profile.updated': eventSchema(
    'profile.updated',
    userActorSchema,
    subjectSchema('profile'),
    z.strictObject({ fields: z.array(z.enum(['image', 'name'])).max(2) })
  ),
  'session.revoked': revokedSchema,
} as const satisfies Record<AuditEventType, z.ZodType>;

export type AuditEventValidationIssue = Readonly<{
  field: string;
  message: string;
}>;

export type AuditEventValidationResult =
  | Readonly<{ event: AuditEventInput; type: 'audit_event_valid' }>
  | Readonly<{
      issues: readonly AuditEventValidationIssue[];
      type: 'audit_event_invalid';
    }>;

const toIssues = (issues: readonly z.ZodIssue[]) =>
  issues.map((issue) => ({
    field: issue.path.length ? issue.path.map(String).join('.') : 'event',
    message: issue.message,
  }));

export function validateAuditEventInput(
  input: unknown
): AuditEventValidationResult {
  const eventType = z
    .object({ type: z.enum(auditEventTypes) })
    .safeParse(input);
  if (!eventType.success) {
    return {
      type: 'audit_event_invalid',
      issues: toIssues(eventType.error.issues),
    };
  }

  const event = eventSchemas[eventType.data.type].safeParse(input);
  if (!event.success) {
    return {
      type: 'audit_event_invalid',
      issues: toIssues(event.error.issues),
    };
  }

  return {
    type: 'audit_event_valid',
    event: event.data as AuditEventInput,
  };
}

export type AuditEventRecord = AuditEventInput &
  Readonly<{
    eventClass: AuditEventClass;
    id: AuditEventId;
    legalHold: boolean;
    occurredAt: Date;
    persistence: AuditPersistencePolicy;
    retainUntil: Date;
    retentionClass: AuditRetentionClass;
  }>;
