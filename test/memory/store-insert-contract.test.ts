import type { Memory } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { createMemoryClient } from "../../src/memory/client-core.js";
import {
	createInMemoryClient,
	createInMemoryStore,
} from "../../src/memory/in-memory.js";
import type { MemoryStore } from "../../src/memory/store.js";
import { verifyStoreInsertContract } from "../fixtures/store-insert-contract.js";
import { expectMnemocyteError } from "../helpers.js";

const config = {
	embedder: {
		model: "store-insert-contract-test",
		dimensions: 1,
		async embed(texts: readonly string[]) {
			return texts.map(() => [1]);
		},
	},
};

function createClientWithInsertTransform(
	transform: (inserted: Memory[]) => Memory[],
) {
	const baseStore = createInMemoryStore();
	const store: MemoryStore = {
		...baseStore,
		async insertMemories(rows) {
			return transform(await baseStore.insertMemories(rows));
		},
	};
	return createMemoryClient(config, store);
}

describe("MemoryStore insert contract", () => {
	test("preserves input order through the in-memory adapter", async () => {
		const client = createInMemoryClient(config);
		try {
			await verifyStoreInsertContract(client, "store_contract_in_memory");
		} finally {
			await client.close();
		}
	});

	test("normalizes complete reversed store results to input order", async () => {
		const client = createClientWithInsertTransform((inserted) =>
			inserted.toReversed(),
		);
		try {
			const remembered = await client.rememberMany({
				inputs: [
					{ entityId: "reverse", content: "first" },
					{ entityId: "reverse", content: "second" },
				],
			});
			expect(remembered.map((memory) => memory.content)).toEqual([
				"first",
				"second",
			]);
		} finally {
			await client.close();
		}
	});

	test.each([
		{
			name: "missing",
			transform: (inserted: Memory[]) => inserted.slice(0, -1),
		},
		{
			name: "duplicate",
			transform: (inserted: Memory[]) => {
				const first = inserted[0];
				return first === undefined ? [] : [first, first];
			},
		},
		{
			name: "unknown",
			transform: (inserted: Memory[]) =>
				inserted.map((memory, index) =>
					index === 1 ? { ...memory, id: "mem_unknown" } : memory,
				),
		},
	])("rejects $name returned IDs with DB", async ({ transform }) => {
		const client = createClientWithInsertTransform(transform);
		try {
			await expectMnemocyteError(
				client.rememberMany({
					inputs: [
						{ entityId: "malformed", content: "first" },
						{ entityId: "malformed", content: "second" },
					],
				}),
				"DB",
			);
		} finally {
			await client.close();
		}
	});
});
