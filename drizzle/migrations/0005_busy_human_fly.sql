CREATE TABLE "outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"aggregateType" text NOT NULL,
	"aggregateId" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deployTarget" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"availableAt" timestamp (3) DEFAULT now() NOT NULL,
	"publishedAt" timestamp (3),
	"lastError" text,
	"dedupeKey" text
);
--> statement-breakpoint
CREATE INDEX "outbox_status_available_at_idx" ON "outbox" USING btree ("status","availableAt");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_dedupe_key_key" ON "outbox" USING btree ("dedupeKey") WHERE "outbox"."dedupeKey" is not null;