import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	createMnemocyte,
	type EntityStats,
	type GlobalStats,
	type MnemocyteObservation,
	type MnemocyteOperation,
} from "mnemocyte";
import postgres from "postgres";
import { describe, expect, test } from "vitest";
import { expectDefined } from "../helpers.js";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;

/**
 * Build a deterministic 1536-d embedding from a seed string. Same input
 * → same vector, so we can produce predictable cosine similarities.
 */
function createEmbedding(seed: string) {
	const values = Array.from({ length: 1536 }, () => 0);
	for (const char of seed) {
		const index = char.charCodeAt(0) % values.length;
		values[index] = (values[index] ?? 0) + 1;
	}
	return values;
}

async function main(databaseUrl: string) {
	const sql = postgres(databaseUrl, { max: 1 });
	const entityId = `integration_${Date.now()}_${Math.random().toString(36).slice(2)}`;
	const migration = await readFile(
		resolve("migrations", "0000_initial.sql"),
		"utf8",
	);

	try {
		await sql.unsafe(migration);
	} catch (error) {
		if (
			!(
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "42P07"
			)
		) {
			throw error;
		}
	}

	try {
		await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
		await sql`DELETE FROM mnemocyte_events WHERE entity_id = ${entityId}`;

		const events: MnemocyteObservation[] = [];
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
			const globalBefore = (await client.stats()) as GlobalStats;
			const emptyEntityStats = (await client.stats({
				entityId,
			})) as EntityStats;
			expect(emptyEntityStats.entityId).toBe(entityId);
			expect(emptyEntityStats.memoryCount).toBe(0);
			expect(emptyEntityStats.activeMemoryCount).toBe(0);
			expect(emptyEntityStats.expiredMemoryCount).toBe(0);
			expect(emptyEntityStats.supersededMemoryCount).toBe(0);

			// 1. Basic remember/recall.
			const memory = await client.remember({
				entityId,
				content: "Prefers concise answers about TypeScript libraries.",
				type: "preference",
				tags: ["dx", "typescript"],
				confidence: 0.9,
			});

			expect(memory.entityId).toBe(entityId);
			expect(memory.embeddingModel).toBe("integration-test");
			expect(memory.embeddingDimensions).toBe(1536);
			expect(memory.supersededAt).toBe(null);

			// 2. rememberMany and a near-duplicate to feed findDuplicates.
			const remembered = await client.rememberMany([
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
			const dup = expectDefined(remembered[0]);
			const unrelated = expectDefined(remembered[1]);
			const expired = await client.remember({
				entityId,
				content: "Expired memory used only for stats parity.",
				type: "session",
				expiresAt: new Date(Date.now() - 60_000),
			});
			void expired;

			const afterRememberStats = await client.stats({ entityId });
			expect(afterRememberStats.memoryCount).toBe(4);
			expect(afterRememberStats.activeMemoryCount).toBe(3);
			expect(afterRememberStats.expiredMemoryCount).toBe(1);
			expect(afterRememberStats.supersededMemoryCount).toBe(0);
			const globalAfterRemember = (await client.stats()) as GlobalStats;
			expect(globalAfterRemember.entityCount).toBe(
				globalBefore.entityCount + 1,
			);
			expect(globalAfterRemember.memoryCount).toBe(
				globalBefore.memoryCount + 4,
			);
			expect(globalAfterRemember.activeMemoryCount).toBe(
				globalBefore.activeMemoryCount + 3,
			);
			expect(globalAfterRemember.expiredMemoryCount).toBe(
				globalBefore.expiredMemoryCount + 1,
			);
			expect(globalAfterRemember.supersededMemoryCount).toBe(
				globalBefore.supersededMemoryCount,
			);

			// 3. recall surfaces the original by tag+type filter.
			const recalled = await client.recall({
				entityId,
				query: "TypeScript library answer style",
				limit: 5,
				types: ["preference"],
				tags: ["dx", "typescript"],
				explain: true,
			});
			expect(recalled.length).toBe(1);
			expect(recalled[0]?.id).toBe(memory.id);
			expect(recalled[0]?.score ?? 0).toBeGreaterThan(0);
			expect(recalled[0]?.explanation).toBeTruthy();

			// 4. findDuplicates returns the dup pair (cosine 1.0 between identical content).
			const pairs = await client.findDuplicates({
				entityId,
				threshold: 0.99,
			});
			expect(pairs.length).toBe(1);
			const pair = expectDefined(pairs[0]);
			const pairIds = [pair.a.id, pair.b.id].sort();
			expect(pairIds).toEqual([memory.id, dup.id].sort());
			expect(pair.similarity).toBeGreaterThanOrEqual(0.99);

			// 5. experimental.consolidate collapses the duplicate.
			const consolidated = await client.experimental.consolidate({
				entityId,
				survivorId: memory.id,
				supersededIds: [dup.id],
			});
			expect(consolidated.survivorId).toBe(memory.id);
			expect(consolidated.supersededCount).toBe(1);
			expect([...consolidated.supersededIds]).toEqual([dup.id]);
			const afterConsolidateStats = await client.stats({ entityId });
			expect(afterConsolidateStats.memoryCount).toBe(4);
			expect(afterConsolidateStats.activeMemoryCount).toBe(2);
			expect(afterConsolidateStats.expiredMemoryCount).toBe(1);
			expect(afterConsolidateStats.supersededMemoryCount).toBe(1);

			// 6. Recall now excludes the loser by default.
			const recalledAfter = await client.recall({
				entityId,
				query: "TypeScript",
			});
			const recalledIds = recalledAfter.map((m) => m.id);
			expect(recalledIds).toContain(memory.id);
			expect(recalledIds).not.toContain(dup.id);

			// 7. Including superseded surfaces the loser with supersededAt set.
			const includingSuperseded = await client.recall({
				entityId,
				query: "TypeScript",
				includeSuperseded: true,
			});
			const loserAfter = includingSuperseded.find((m) => m.id === dup.id);
			expect(loserAfter).toBeTruthy();
			const supersededLoser = expectDefined(loserAfter);
			expect(supersededLoser.supersededBy).toBe(memory.id);
			expect(supersededLoser.supersededAt).toBeInstanceOf(Date);

			// 8. buildContext returns a non-empty string.
			const context = await client.buildContext({
				entityId,
				query: "TypeScript",
				format: "markdown",
			});
			expect(typeof context).toBe("string");
			expect(context.length).toBeGreaterThan(0);

			// 9. listAuditLog surfaces the recorded events.
			const log = await client.listAuditLog({ entityId, limit: 50 });
			const descriptions = log.map((event) => event.description).sort();
			expect(descriptions).toContain("memory.created");
			expect(descriptions).toContain("memory.superseded");
			const superseded = log.find(
				(event) => event.description === "memory.superseded",
			);
			expect(superseded?.metadata.memoryId).toBe(dup.id);
			expect(superseded?.metadata.supersededBy).toBe(memory.id);

			// 10. prune the superseded memory by selector.
			const pruneResult = await client.prune({
				entityId,
				superseded: true,
			});
			expect(pruneResult.deletedCount).toBe(1);
			const afterPrune = await client.stats({ entityId });
			expect(afterPrune.memoryCount).toBe(3);
			expect(afterPrune.activeMemoryCount).toBe(2);
			expect(afterPrune.expiredMemoryCount).toBe(1);
			expect(afterPrune.supersededMemoryCount).toBe(0);

			// 11. forgetAll wipes remaining memories but keeps audit history.
			await client.forgetAll({ entityId });
			const afterForget = await client.stats({ entityId });
			expect(afterForget.memoryCount).toBe(0);
			expect(afterForget.activeMemoryCount).toBe(0);
			expect(afterForget.expiredMemoryCount).toBe(0);
			expect(afterForget.supersededMemoryCount).toBe(0);
			const globalAfterForget = (await client.stats()) as GlobalStats;
			expect(globalAfterForget.entityCount).toBe(globalBefore.entityCount);
			expect(globalAfterForget.memoryCount).toBe(globalBefore.memoryCount);
			expect(globalAfterForget.activeMemoryCount).toBe(
				globalBefore.activeMemoryCount,
			);
			expect(globalAfterForget.expiredMemoryCount).toBe(
				globalBefore.expiredMemoryCount,
			);
			expect(globalAfterForget.supersededMemoryCount).toBe(
				globalBefore.supersededMemoryCount,
			);
			const logAfterForget = await client.listAuditLog({ entityId });
			expect(
				logAfterForget.some((event) => event.description === "entity.cleared"),
			).toBeTruthy();
			expect(
				logAfterForget.some((event) => event.description === "memory.created"),
			).toBeTruthy();

			// 12. Observability captured at least one success event for each op exercised.
			const operations = new Set(
				events
					.filter((event) => event.phase === "success")
					.map((event) => event.operation),
			);
			const expectedOperations: MnemocyteOperation[] = [
				"remember",
				"rememberMany",
				"recall",
				"buildContext",
				"findDuplicates",
				"consolidate",
				"listAuditLog",
				"prune",
				"forgetAll",
			];
			for (const op of expectedOperations) {
				expect(operations.has(op), `missing success event for "${op}"`).toBe(
					true,
				);
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

describe("Postgres integration", () => {
	test.skipIf(!databaseUrl)(
		"exercises the full Postgres-backed client path",
		async () => {
			await main(databaseUrl ?? "");
		},
		60_000,
	);
});
