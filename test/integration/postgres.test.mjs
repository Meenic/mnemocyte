import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { createMnemocyte } from "../../dist/index.mjs";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
	console.log("Skipping Postgres integration test: DATABASE_URL is not set.");
	process.exit(0);
}

function createEmbedding(seed) {
	const values = Array.from({ length: 1536 }, () => 0);
	for (const char of seed) {
		const index = char.charCodeAt(0) % values.length;
		values[index] += 1;
	}
	return values;
}

async function main() {
	const sql = postgres(databaseUrl, { max: 1 });
	const entityId = `integration_${Date.now()}_${Math.random().toString(36).slice(2)}`;
	const migration = await readFile(
		resolve("migrations", "0000_initial.sql"),
		"utf8",
	);

	try {
		await sql.unsafe(migration);
		await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;

		const client = createMnemocyte({
			databaseUrl,
			embedder: {
				model: "integration-test",
				dimensions: 1536,
				async embed(texts) {
					return texts.map(createEmbedding);
				},
			},
		});

		try {
			const memory = await client.remember({
				entityId,
				content: "Prefers concise answers about TypeScript libraries.",
				type: "preference",
				tags: ["dx", "typescript"],
				confidence: 0.9,
			});

			assert.equal(memory.entityId, entityId);
			assert.equal(memory.embeddingModel, "integration-test");
			assert.equal(memory.embeddingDimensions, 1536);

			const recalled = await client.recall({
				entityId,
				query: "TypeScript library answer style",
				limit: 3,
				types: ["preference"],
				tags: ["typescript"],
				explain: true,
			});

			assert.equal(recalled.length, 1);
			assert.equal(recalled[0]?.id, memory.id);
			assert.ok((recalled[0]?.score ?? 0) > 0);
			assert.ok(recalled[0]?.explanation);

			const stats = await client.stats({ entityId });
			assert.equal(stats.memoryCount, 1);
			assert.equal(stats.activeMemoryCount, 1);

			await client.forget({ entityId, memoryId: memory.id });
			const afterForget = await client.stats({ entityId });
			assert.equal(afterForget.memoryCount, 0);
		} finally {
			await client.close();
		}
	} finally {
		await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
		await sql.end();
	}
}

await main();
console.log("Postgres integration test passed.");
