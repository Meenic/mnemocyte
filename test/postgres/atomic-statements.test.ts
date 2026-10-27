import { describe, expect, test } from "vitest";
import { createPostgresStore } from "../../src/memory/postgres.js";
import { createUuidV7 } from "../../src/memory/records.js";
import type { SqlExecutor } from "../../src/sql/executor.js";
import { expectMnemocyteError } from "../helpers.js";

interface RecordedQuery {
	sql: string;
	params: readonly unknown[];
	signal: AbortSignal | undefined;
}

function createRecordingExecutor(rows: Record<string, unknown>[]): {
	executor: SqlExecutor;
	queries: RecordedQuery[];
} {
	const queries: RecordedQuery[] = [];
	const executor: SqlExecutor = {
		async query<Row>(
			sql: string,
			params: readonly unknown[],
			options?: { signal?: AbortSignal },
		): Promise<Row[]> {
			queries.push({ sql, params, signal: options?.signal });
			return rows as Row[];
		},
		async transaction() {
			throw new Error("No write path may open an interactive transaction.");
		},
	};
	return { executor, queries };
}

describe("Postgres single-statement writes", () => {
	test("consolidates in one scoped statement without a transaction", async () => {
		const survivorId = createUuidV7();
		const loserId = createUuidV7();
		const { executor, queries } = createRecordingExecutor([
			{
				survivorActive: true,
				hasConflict: false,
				supersededIds: JSON.stringify([loserId]),
			},
		]);
		const store = createPostgresStore(executor);
		const controller = new AbortController();

		const result = await store.consolidate(
			{
				entityId: "alice",
				survivorId,
				supersededIds: [loserId],
				mergeTags: true,
				now: new Date(),
				auditEnabled: true,
			},
			{ signal: controller.signal },
		);

		expect(result.supersededIds).toEqual([loserId]);
		expect(queries).toHaveLength(1);
		const [query] = queries;
		expect(query?.signal).toBe(controller.signal);
		expect(query?.sql).toContain("FOR UPDATE");
		expect(query?.sql).toContain("INSERT INTO mnemocyte_events");
		expect(query?.sql).toContain("tags_updated AS");
		expect(query?.sql).toContain("namespace = $");
		expect(query?.params).toContain("default");
		expect(query?.params).toContain("alice");
	});

	test("reports a survivor that changed as a conflict", async () => {
		const { executor } = createRecordingExecutor([
			{ survivorActive: false, hasConflict: false, supersededIds: "[]" },
		]);
		const store = createPostgresStore(executor);

		await expectMnemocyteError(
			store.consolidate({
				entityId: "alice",
				survivorId: createUuidV7(),
				supersededIds: [createUuidV7()],
				mergeTags: false,
				now: new Date(),
				auditEnabled: false,
			}),
			"CONFLICT",
		);
	});

	test("scopes id lookups and skips ids that cannot be UUIDs", async () => {
		const { executor, queries } = createRecordingExecutor([]);
		const store = createPostgresStore(executor);
		const id = createUuidV7();

		await store.markMemoriesAccessed("alice", [id, "mem_legacy"]);
		expect(await store.deleteMemory("alice", "mem_legacy")).toBe(false);

		expect(queries).toHaveLength(1);
		for (const query of queries) {
			expect(query.sql).toContain("entity_id = $");
			expect(query.params).toContain("alice");
			expect(query.params).not.toContain("mem_legacy");
		}
	});
});
