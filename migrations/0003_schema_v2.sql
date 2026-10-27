ALTER TABLE "mnemocyte_memories" ADD COLUMN "namespace" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mnemocyte_memories" ALTER COLUMN "namespace" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "mnemocyte_memories" RENAME COLUMN "type" TO "kind";
--> statement-breakpoint
DO $$
BEGIN
	-- Postgres 18 names NOT NULL constraints after the column and keeps the old
	-- name on a rename; a fresh install calls it "mnemocyte_memories_kind_not_null".
	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_constraint
		WHERE conrelid = '"mnemocyte_memories"'::regclass
			AND conname = 'mnemocyte_memories_type_not_null'
	) THEN
		ALTER TABLE "mnemocyte_memories" RENAME CONSTRAINT "mnemocyte_memories_type_not_null" TO "mnemocyte_memories_kind_not_null";
	END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "mnemocyte_memories" DROP CONSTRAINT "mnemocyte_memories_superseded_by_mnemocyte_memories_id_fk";
--> statement-breakpoint
DROP INDEX "mnemocyte_memories_entity_idx";
--> statement-breakpoint
DROP INDEX "mnemocyte_memories_entity_type_idx";
--> statement-breakpoint
ALTER TABLE "mnemocyte_memories"
	ALTER COLUMN "id" TYPE uuid USING (
		CASE
			WHEN "id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN "id"::uuid
			ELSE md5("id")::uuid
		END
	),
	ALTER COLUMN "superseded_by" TYPE uuid USING (
		CASE
			WHEN "superseded_by" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN "superseded_by"::uuid
			ELSE md5("superseded_by")::uuid
		END
	),
	ADD COLUMN "agent_id" text,
	ADD COLUMN "session_id" text,
	ADD COLUMN "key" text,
	ADD COLUMN "content_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, "content")) STORED;
--> statement-breakpoint
ALTER TABLE "mnemocyte_memories" ADD CONSTRAINT "mnemocyte_memories_superseded_by_mnemocyte_memories_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."mnemocyte_memories"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "mnemocyte_memories_scope_idx" ON "mnemocyte_memories" USING btree ("namespace","entity_id","agent_id","session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "mnemocyte_memories_scope_key_idx" ON "mnemocyte_memories" USING btree ("namespace","entity_id","agent_id","session_id","key") NULLS NOT DISTINCT WHERE "key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "mnemocyte_memories_superseded_by_idx" ON "mnemocyte_memories" USING btree ("superseded_by") WHERE "superseded_by" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "mnemocyte_memories_content_tsv_idx" ON "mnemocyte_memories" USING gin ("content_tsv");
--> statement-breakpoint
DROP INDEX "mnemocyte_events_entity_time_idx";
--> statement-breakpoint
ALTER TABLE "mnemocyte_events"
	ALTER COLUMN "id" TYPE uuid USING (
		CASE
			WHEN "id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN "id"::uuid
			ELSE md5("id")::uuid
		END
	),
	ADD COLUMN "namespace" text DEFAULT 'default' NOT NULL,
	ADD COLUMN "agent_id" text,
	ADD COLUMN "session_id" text;
--> statement-breakpoint
ALTER TABLE "mnemocyte_events" ALTER COLUMN "namespace" DROP DEFAULT;
--> statement-breakpoint
UPDATE "mnemocyte_events"
SET "metadata" = "metadata"
	|| CASE
		WHEN jsonb_typeof("metadata"->'memoryId') = 'string' THEN jsonb_build_object(
			'memoryId',
			CASE
				WHEN "metadata"->>'memoryId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ("metadata"->>'memoryId')::uuid
				ELSE md5("metadata"->>'memoryId')::uuid
			END::text
		)
		ELSE '{}'::jsonb
	END
	|| CASE
		WHEN jsonb_typeof("metadata"->'supersededBy') = 'string' THEN jsonb_build_object(
			'supersededBy',
			CASE
				WHEN "metadata"->>'supersededBy' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ("metadata"->>'supersededBy')::uuid
				ELSE md5("metadata"->>'supersededBy')::uuid
			END::text
		)
		ELSE '{}'::jsonb
	END
WHERE jsonb_typeof("metadata"->'memoryId') = 'string'
	OR jsonb_typeof("metadata"->'supersededBy') = 'string';
--> statement-breakpoint
CREATE INDEX "mnemocyte_events_scope_time_idx" ON "mnemocyte_events" USING btree ("namespace","entity_id","timestamp","id");
--> statement-breakpoint
ALTER TABLE "mnemocyte_meta" ADD COLUMN "vector_type" text DEFAULT 'vector' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mnemocyte_meta" ADD CONSTRAINT "mnemocyte_meta_vector_type_check" CHECK ("vector_type" IN ('vector', 'halfvec'));
