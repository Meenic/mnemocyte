import { describe, expect, test } from "vitest";
import type { DatabaseHandle, MnemocyteDatabase } from "../../src/db/index.js";
import { createPostgresStore } from "../../src/memory/postgres.js";
import { expectMnemocyteError } from "../helpers.js";

describe("Postgres prune validation", () => {
	test("does not issue DELETE for an empty internal filter", async () => {
		let queryCount = 0;
		const handle: DatabaseHandle = {
			db: {
				$client: {
					unsafe() {
						queryCount += 1;
						return Promise.resolve([]);
					},
				},
			} as unknown as MnemocyteDatabase,
			async close() {},
		};
		const store = createPostgresStore(handle);

		await expectMnemocyteError(store.prune({ dryRun: false }), "VALIDATION");
		expect(queryCount).toBe(0);
	});
});
