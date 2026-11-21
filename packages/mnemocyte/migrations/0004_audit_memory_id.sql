ALTER TABLE "mnemocyte_events" ADD COLUMN "memory_id" uuid GENERATED ALWAYS AS (
	CASE
		WHEN "metadata"->>'memoryId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN ("metadata"->>'memoryId')::uuid
	END
) STORED;
--> statement-breakpoint
CREATE INDEX "mnemocyte_events_memory_idx" ON "mnemocyte_events" USING btree ("memory_id","timestamp","id");
