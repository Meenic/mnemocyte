// Save, update and find memories without a database. They live in process
// memory until the script exits; pglite.ts and postgres.ts keep them.
//
// Needs OPENAI_API_KEY. From the repository root, after `pnpm build`:
//
//   node examples/in-memory.ts
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";

if (!process.env.OPENAI_API_KEY) {
	console.error("Set OPENAI_API_KEY to run this example.");
	process.exit(1);
}

// Leaving out `store` keeps memories in process memory.
const memory = createMemory({
	namespace: "examples",
	embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});

// A client bound to one user: every call below reads and writes only their
// memories.
const user = memory.for({ entityId: "user_123" });

await user.addMany({
	memories: [
		{
			key: "reply-style",
			kind: "preference",
			content: "Prefers short, direct answers.",
		},
		{ key: "city", content: "Lives in Berlin." },
		{ content: "Is building an invoicing CLI in TypeScript." },
	],
});

// Adding the same key again updates that memory in place: same id, new
// content. An add without a key always inserts a new memory.
await user.add({ key: "city", content: "Moved to Lisbon in March." });

// The best matches for a question, with a score from 0 to 1.
const results = await user.search({
	query: "Where does the user live?",
	limit: 2,
});
for (const result of results) {
	console.log(result.score.toFixed(3), result.content);
}

// The same search, rendered as Markdown for a system prompt.
const context = await user.context({
	query: "How should I answer the user?",
	maxTokens: 500,
});
console.log(`\n${context}`);
