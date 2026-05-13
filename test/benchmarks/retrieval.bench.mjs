import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createMnemocyte } from "../../dist/index.mjs";
import {
	retrievalConfig,
	testEmbedder,
} from "../fixtures/retrieval-quality.mjs";

const MEMORY_COUNT = 200;
const QUERY_COUNT = 25;
const contents = [
	"Prefers concise TypeScript library answers.",
	"Postgres and pgvector store memory embeddings.",
	"Release workflow uses npm publish after version bump.",
	"Database migration scripts should be explicit and reviewed.",
	"Short responses are preferred for direct workflow questions.",
];

const client = createMnemocyte({
	embedder: testEmbedder,
	retrieval: retrievalConfig,
});
const entityId = `retrieval_bench_${Date.now()}_${Math.random().toString(36).slice(2)}`;

try {
	for (let index = 0; index < MEMORY_COUNT; index += 1) {
		await client.remember({
			entityId,
			content: contents[index % contents.length],
			type: index % 2 === 0 ? "preference" : "fact",
			importance: index % 5 === 0 ? "high" : "normal",
			confidence: 0.8 + (index % 3) * 0.05,
		});
	}

	await client.recall({
		entityId,
		query: "typescript concise answers",
		limit: 5,
	});

	const startedAt = performance.now();
	for (let index = 0; index < QUERY_COUNT; index += 1) {
		const results = await client.recall({
			entityId,
			query:
				index % 2 === 0
					? "typescript concise answers"
					: "postgres pgvector database",
			limit: 5,
		});
		assert.ok(results.length > 0);
	}
	const durationMs = performance.now() - startedAt;
	const averageMs = durationMs / QUERY_COUNT;

	console.log(
		JSON.stringify(
			{
				memoryCount: MEMORY_COUNT,
				queryCount: QUERY_COUNT,
				averageRecallMs: Number(averageMs.toFixed(3)),
			},
			null,
			2,
		),
	);
} finally {
	await client.close();
}
