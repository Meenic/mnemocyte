import { describe, expect, test } from "vitest";
import { createPostgresStore } from "../../src/memory/postgres.js";
import type { SqlExecutor } from "../../src/sql/executor.js";
import { expectMnemocyteError } from "../helpers.js";

describe("Postgres prune validation", () => {
	test("does not issue DELETE for an empty internal filter", async () => {
		let queryCount = 0;
		const executor: SqlExecutor = {
			async query() {
				queryCount += 1;
				return [];
			},
			async transaction(fn) {
				return fn(executor);
			},
		};
		const store = createPostgresStore(executor);

		await expectMnemocyteError(store.prune({ dryRun: false }), "VALIDATION");
		expect(queryCount).toBe(0);
	});
});
