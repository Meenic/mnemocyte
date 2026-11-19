// Memories in your own Postgres with pgvector, through postgres.js.
//
// Needs OPENAI_API_KEY and DATABASE_URL. To start a local Postgres with
// pgvector, the image Mnemocyte's CI uses:
//
//   docker run -d --name mnemocyte-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:0.8.7-pg18
//   export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
//
// Then, from the repository root, after `pnpm build`:
//
//   node examples/postgres.ts
import { createMemory, migrate } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !process.env.OPENAI_API_KEY) {
	console.error("Set DATABASE_URL and OPENAI_API_KEY to run this example.");
	process.exit(1);
}

const sql = postgres(databaseUrl);

const memory = createMemory({
	namespace: "examples",
	store: sql,
	embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});

try {
	// Mnemocyte never creates tables on its own. In an app, run
	// `pnpm exec mnemocyte migrate` on deploy; here migrate() does the same
	// from code. Enabling pgvector needs a superuser, which the Docker
	// image's `postgres` user is.
	const { applied } = await migrate({ memory, createExtension: true });
	if (applied.length > 0) {
		console.log(`Applied migrations: ${applied.join(", ")}\n`);
	}

	const user = memory.for({ entityId: "user_123" });

	// Keys make the adds safe to repeat: a second run updates these memories
	// instead of adding copies.
	await user.add({
		key: "reply-style",
		kind: "preference",
		content: "Prefers short, direct answers.",
	});
	await user.add({ key: "timezone", content: "Timezone is Europe/Berlin." });
	await user.add({
		key: "project",
		content: "Is building an invoicing CLI in TypeScript.",
	});

	const context = await user.context({
		query: "When is the invoice due in the user's local time?",
		maxTokens: 500,
	});
	console.log(context);
} finally {
	// The database client stays yours. A script ends it so Node can exit; a
	// server keeps it open.
	await sql.end();
}
