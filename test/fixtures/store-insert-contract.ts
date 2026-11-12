import type { MemoryClient } from "mnemocyte";
import { expect } from "vitest";
import { testScope } from "../helpers.js";

export async function verifyStoreInsertContract(
	client: MemoryClient,
	entityId: string,
): Promise<void> {
	const inputs = [
		{ content: "first input" },
		{ content: "second input" },
		{ content: "third input" },
	];

	const remembered = await client.addMany({
		scope: testScope(entityId),
		memories: inputs,
	});

	expect(remembered.map((memory) => memory.content)).toEqual(
		inputs.map((input) => input.content),
	);
	expect(new Set(remembered.map((memory) => memory.id)).size).toBe(
		inputs.length,
	);
}
