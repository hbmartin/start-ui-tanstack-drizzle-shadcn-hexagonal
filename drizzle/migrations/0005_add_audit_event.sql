CREATE TABLE "audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"occurredAt" timestamp (3) with time zone NOT NULL,
	"type" text NOT NULL,
	"eventClass" text NOT NULL,
	"persistence" text NOT NULL,
	"actorKind" text NOT NULL,
	"actorId" text,
	"subjectKind" text,
	"subjectId" text,
	"correlationId" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"retentionClass" text NOT NULL,
	"retainUntil" timestamp (3) with time zone,
	"legalHold" boolean NOT NULL,
	CONSTRAINT "audit_event_definition_check" CHECK ((("audit_event"."type", "audit_event"."eventClass", "audit_event"."persistence", "audit_event"."retentionClass") in (
        ('administration.user-deleted', 'administration', 'required', 'administrative'),
        ('authentication.failed', 'authentication', 'required', 'security'),
        ('authentication.signed-in', 'authentication', 'required', 'security'),
        ('authentication.signed-out', 'authentication', 'required', 'security'),
        ('authorization.role-changed', 'authorization', 'required', 'security'),
        ('data.book-deleted', 'data', 'required', 'standard'),
        ('profile.updated', 'profile', 'best-effort', 'standard'),
        ('session.revoked', 'authentication', 'required', 'security')
      )) is true),
	CONSTRAINT "audit_event_actor_check" CHECK (((
        ("audit_event"."actorKind" = 'anonymous' and "audit_event"."actorId" is null) or
        ("audit_event"."actorKind" = 'user' and "audit_event"."actorId" is not null) or
        ("audit_event"."actorKind" = 'system' and "audit_event"."actorId" in ('application', 'auth-provider'))
      )) is true),
	CONSTRAINT "audit_event_subject_pair_check" CHECK (((
        ("audit_event"."subjectKind" is null and "audit_event"."subjectId" is null) or
        ("audit_event"."subjectKind" in ('application', 'auth-identity', 'book', 'invite', 'profile', 'session', 'user') and "audit_event"."subjectId" is not null)
      )) is true),
	CONSTRAINT "audit_event_identifier_check" CHECK (("audit_event"."correlationId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and ("audit_event"."actorId" is null or "audit_event"."actorId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$')
        and ("audit_event"."subjectId" is null or "audit_event"."subjectId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$')) is true),
	CONSTRAINT "audit_event_metadata_object_check" CHECK ((jsonb_typeof("audit_event"."metadata") = 'object') is true),
	CONSTRAINT "audit_event_retention_check" CHECK (("audit_event"."retainUntil" is not null and "audit_event"."retainUntil" > "audit_event"."occurredAt") is true),
	CONSTRAINT "audit_event_semantics_check" CHECK (((
        ("audit_event"."type" = 'administration.user-deleted'
          and "audit_event"."actorKind" = 'user' and "audit_event"."subjectKind" = 'user'
          and "audit_event"."metadata"->>'reason' in ('administrator', 'self-service')
          and "audit_event"."metadata" - array['reason']::text[] = '{}'::jsonb
          and ("audit_event"."metadata"->>'reason' <> 'self-service' or "audit_event"."actorId" = "audit_event"."subjectId")) or
        ("audit_event"."type" = 'authentication.failed'
          and "audit_event"."metadata"->>'method' in ('oauth', 'otp', 'password')
          and "audit_event"."metadata"->>'reason' in ('invalid-credential', 'locked', 'rate-limited', 'unknown-user')
          and "audit_event"."metadata" - array['method', 'reason']::text[] = '{}'::jsonb
          and (("audit_event"."actorKind" = 'anonymous' and "audit_event"."subjectKind" is null)
            or ("audit_event"."actorKind" = 'user' and "audit_event"."subjectKind" = 'user'
              and "audit_event"."actorId" = "audit_event"."subjectId"
              and "audit_event"."metadata"->>'reason' <> 'unknown-user'))) or
        ("audit_event"."type" = 'authentication.signed-in'
          and "audit_event"."actorKind" = 'user' and "audit_event"."subjectKind" = 'user'
          and "audit_event"."actorId" = "audit_event"."subjectId"
          and "audit_event"."metadata"->>'method' in ('oauth', 'otp', 'password')
          and "audit_event"."metadata" - array['method']::text[] = '{}'::jsonb) or
        ("audit_event"."type" = 'authentication.signed-out'
          and "audit_event"."actorKind" = 'user'
          and "audit_event"."metadata" - array['scope']::text[] = '{}'::jsonb
          and (("audit_event"."metadata"->>'scope' = 'current-session' and "audit_event"."subjectKind" = 'session')
            or ("audit_event"."metadata"->>'scope' = 'all' and "audit_event"."subjectKind" = 'user' and "audit_event"."actorId" = "audit_event"."subjectId"))) or
        ("audit_event"."type" = 'authorization.role-changed'
          and "audit_event"."actorKind" = 'user' and "audit_event"."subjectKind" = 'user'
          and "audit_event"."metadata"->>'from' in ('admin', 'user')
          and "audit_event"."metadata"->>'to' in ('admin', 'user')
          and "audit_event"."metadata"->>'from' <> "audit_event"."metadata"->>'to'
          and "audit_event"."metadata" - array['from', 'to']::text[] = '{}'::jsonb) or
        ("audit_event"."type" = 'data.book-deleted'
          and "audit_event"."actorKind" = 'user' and "audit_event"."subjectKind" = 'book'
          and "audit_event"."metadata" = '{}'::jsonb) or
        ("audit_event"."type" = 'profile.updated'
          and "audit_event"."actorKind" = 'user' and "audit_event"."subjectKind" = 'profile'
          and jsonb_typeof("audit_event"."metadata"->'fields') = 'array'
          and "audit_event"."metadata" - array['fields']::text[] = '{}'::jsonb) or
        ("audit_event"."type" = 'session.revoked'
          and "audit_event"."actorKind" in ('system', 'user')
          and "audit_event"."metadata"->>'reason' in ('administrator', 'role-change', 'user-request')
          and "audit_event"."metadata" - array['reason', 'scope']::text[] = '{}'::jsonb
          and (("audit_event"."metadata"->>'scope' = 'single' and "audit_event"."subjectKind" = 'session')
            or ("audit_event"."metadata"->>'scope' = 'all' and "audit_event"."subjectKind" = 'user')))
      )) is true)
);
--> statement-breakpoint
CREATE INDEX "audit_event_occurred_at_idx" ON "audit_event" USING btree ("occurredAt");--> statement-breakpoint
CREATE INDEX "audit_event_correlation_id_idx" ON "audit_event" USING btree ("correlationId");--> statement-breakpoint
CREATE INDEX "audit_event_subject_idx" ON "audit_event" USING btree ("subjectKind","subjectId");--> statement-breakpoint
CREATE INDEX "audit_event_retention_idx" ON "audit_event" USING btree ("legalHold","retainUntil");