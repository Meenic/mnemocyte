// Memories that survive a restart, in Postgres running inside this process
// with PGlite: no Docker and no DATABASE_URL. The data lives in
// examples/memory-data.
//
// Needs OPENAI_API_KEY. From the repository root, after `pnpm build`, save
// a memory, then run it again without one to see it is still there:
//
//   node examples/pglite.ts "Drinks tea, not coffee."
//   node examples/pglite.ts
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createMemory, migrate } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";

if (!process.env.OPENAI_API_KEY) {
	console.error("Set OPENAI_API_KEY to run this example.");
	process.exit(1);
}

// A data folder opens in one process at a time.
const db = await PGlite.create({
	dataDir: join(import.meta.dirname, "memory-data"),
	extensions: { vector },
});

const memory = createMemory({
	namespace: "examples",
	store: db,
	embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});

try {
	// Mnemocyte never creates tables on its own. migrate() enables pgvector
	// and creates them on the first run, and applies nothing after that.
	await migrate({ memory, createExtension: true });

	const user = memory.for({ entityId: "user_123" });

	const note = process.argv[2];
	if (note) {
		await user.add({ content: note });
		console.log(`Saved: ${note}\n`);
	}

	const { memories } = await user.list({ limit: 20 });
	if (memories.length === 0) {
		console.log("Nothing stored yet. Pass a sentence to save one.");
	} else {
		console.log("Stored, newest first:");
		for (const saved of memories) {
			console.log(`- ${saved.content}`);
		}
		const context = await user.context({
			query: "What should I know before I answer the user?",
			maxTokens: 500,
		});
		console.log(`\n${context}`);
	}
} finally {
	// The database stays yours: close it so the script can exit.
	await db.close();
}
