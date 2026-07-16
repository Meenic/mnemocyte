ALTER TABLE "mnemocyte_meta" ADD COLUMN "embedding_model" text;
--> statement-breakpoint
UPDATE "mnemocyte_meta"
SET "embedding_model" = (
	SELECT min("embedding_model")
	FROM "mnemocyte_memories"
	HAVING count(DISTINCT "embedding_model") = 1
)
WHERE
	"key" = 'installation'
	AND "embedding_model" IS NULL
	AND (
		SELECT count(DISTINCT "embedding_model")
		FROM "mnemocyte_memories"
	) = 1;
