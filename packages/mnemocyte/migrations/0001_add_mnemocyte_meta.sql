CREATE TABLE "mnemocyte_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"embedding_dimensions" integer NOT NULL
);
--> statement-breakpoint
INSERT INTO "mnemocyte_meta" ("key", "embedding_dimensions") VALUES ('installation', 1536);
