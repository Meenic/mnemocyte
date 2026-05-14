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

/**
 * Build a deterministic 1536-d embedding from a seed string. Same input
 * → same vector, so we can produce predictable cosine similarities.
 */
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
		await sql`DELETE FROM mnemocyte_events WHERE entity_id = ${entityId}`;

		const events = [];
		const client = createMnemocyte({
			databaseUrl,
			embedder: {
				model: "integration-test",
				dimensions: 1536,
				async embed(texts) {
					return texts.map(createEmbedding);
				},
			},
			audit: { enabled: true },
			observability: {
				onEvent(event) {
					events.push(event);
				},
			},
		});

		try {
			// 1. Basic remember/recall.
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
			assert.equal(memory.supersededAt, null);

			// 2. rememberMany and a near-duplicate to feed findDuplicates.
			const [dup, unrelated] = await client.rememberMany([
				{
					entityId,
					content: "Prefers concise answers about TypeScript libraries.",
					type: "preference",
					tags: ["dx"],
				},
				{
					entityId,
					content: "Lives in Berlin, speaks German.",
					type: "fact",
					tags: ["location"],
				},
			]);

			// 3. recall surfaces the original by tag+type filter.
			const recalled = await client.recall({
				entityId,
				query: "TypeScript library answer style",
				limit: 5,
				types: ["preference"],
				tags: ["dx", "typescript"],
				explain: true,
			});
			assert.equal(recalled.length, 1);
			assert.equal(recalled[0]?.id, memory.id);
			assert.ok((recalled[0]?.score ?? 0) > 0);
			assert.ok(recalled[0]?.explanation);

			// 4. findDuplicates returns the dup pair (cosine 1.0 between identical content).
			const pairs = await client.findDuplicates({
				entityId,
				threshold: 0.99,
			});
			assert.equal(pairs.length, 1);
			const pairIds = [pairs[0].a.id, pairs[0].b.id].sort();
			assert.deepEqual(pairIds, [memory.id, dup.id].sort());
			assert.ok(pairs[0].similarity >= 0.99);

			// 5. experimental.consolidate collapses the duplicate.
			const consolidated = await client.experimental.consolidate({
				entityId,
				survivorId: memory.id,
				supersededIds: [dup.id],
			});
			assert.equal(consolidated.survivorId, memory.id);
			assert.equal(consolidated.supersededCount, 1);
			assert.deepEqual([...consolidated.supersededIds], [dup.id]);

			// 6. Recall now excludes the loser by default.
			const recalledAfter = await client.recall({
				entityId,
				query: "TypeScript",
			});
			const recalledIds = recalledAfter.map((m) => m.id);
			assert.ok(recalledIds.includes(memory.id));
			assert.ok(!recalledIds.includes(dup.id));

			// 7. Including superseded surfaces the loser with supersededAt set.
			const includingSuperseded = await client.recall({
				entityId,
				query: "TypeScript",
				includeSuperseded: true,
			});
			const loserAfter = includingSuperseded.find((m) => m.id === dup.id);
			assert.ok(loserAfter);
			assert.equal(loserAfter.supersededBy, memory.id);
			assert.ok(loserAfter.supersededAt instanceof Date);

			// 8. buildContext returns a non-empty string.
			const context = await client.buildContext({
				entityId,
				query: "TypeScript",
				format: "markdown",
			});
			assert.equal(typeof context, "string");
			assert.ok(context.length > 0);

			// 9. listAuditLog surfaces the recorded events.
			const log = await client.listAuditLog({ entityId, limit: 50 });
			const descriptions = log.map((event) => event.description).sort();
			assert.ok(descriptions.includes("memory.created"));
			assert.ok(descriptions.includes("memory.superseded"));
			const superseded = log.find(
				(event) => event.description === "memory.superseded",
			);
			assert.equal(superseded?.metadata.memoryId, dup.id);
			assert.equal(superseded?.metadata.supersededBy, memory.id);

			// 10. prune the superseded memory by selector.
			const pruneResult = await client.prune({
				entityId,
				superseded: true,
			});
			assert.equal(pruneResult.deletedCount, 1);
			const afterPrune = await client.stats({ entityId });
			assert.equal(afterPrune.supersededMemoryCount, 0);

			// 11. forgetAll wipes remaining memories but keeps audit history.
			await client.forgetAll({ entityId });
			const afterForget = await client.stats({ entityId });
			assert.equal(afterForget.memoryCount, 0);
			const logAfterForget = await client.listAuditLog({ entityId });
			assert.ok(
				logAfterForget.some((event) => event.description === "entity.cleared"),
			);
			assert.ok(
				logAfterForget.some((event) => event.description === "memory.created"),
			);

			// 12. Observability captured at least one success event for each op exercised.
			const operations = new Set(
				events
					.filter((event) => event.phase === "success")
					.map((event) => event.operation),
			);
			for (const op of [
				"remember",
				"rememberMany",
				"recall",
				"buildContext",
				"findDuplicates",
				"consolidate",
				"listAuditLog",
				"prune",
				"forgetAll",
			]) {
				assert.ok(operations.has(op), `missing success event for "${op}"`);
			}

			// Silence the "unrelated" linter complaint while keeping it in the
			// scenario for realism — it never participates in the dedup pair.
			void unrelated;
		} finally {
			await client.close();
		}
	} finally {
		await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
		await sql`DELETE FROM mnemocyte_events WHERE entity_id = ${entityId}`;
		await sql.end();
	}
}

await main();
console.log("Postgres integration test passed.");
