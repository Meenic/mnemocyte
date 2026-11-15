import { describe, expect, test } from "vitest";
import { createPostgresStore } from "../../src/memory/postgres.js";
import type { SqlExecutor } from "../../src/sql/executor.js";

function createRecordingExecutor(): {
	executor: SqlExecutor;
	signals: (AbortSignal | undefined)[];
} {
	const signals: (AbortSignal | undefined)[] = [];
	const executor: SqlExecutor = {
		async query<Row>(
			_sql: string,
			_params: readonly unknown[],
			options?: { signal?: AbortSignal },
		): Promise<Row[]> {
			signals.push(options?.signal);
			return [
				{
					entityCount: 1,
					memoryCount: 2,
					activeMemoryCount: 2,
					expiredMemoryCount: 0,
					supersededMemoryCount: 0,
				},
			] as Row[];
		},
		async transaction() {
			throw new Error("stats must not open a transaction.");
		},
	};
	return { executor, signals };
}

describe("Postgres stats", () => {
	test("passes the caller's signal to the count query", async () => {
		const { executor, signals } = createRecordingExecutor();
		const store = createPostgresStore(executor);
		const controller = new AbortController();

		const stats = await store.stats(
			{ namespace: "test", entityId: "alice" },
			new Date(),
			{ signal: controller.signal },
		);

		expect(stats.memoryCount).toBe(2);
		expect(signals).toEqual([controller.signal]);
	});

	test("sends no signal option without one", async () => {
		const { executor, signals } = createRecordingExecutor();
		const store = createPostgresStore(executor);

		await store.stats({ namespace: null }, new Date());

		expect(signals).toEqual([undefined]);
	});
});
