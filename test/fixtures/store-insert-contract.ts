import type { MnemocyteClient } from "mnemocyte";
import { expect } from "vitest";

export async function verifyStoreInsertContract(
	client: MnemocyteClient,
	entityId: string,
): Promise<void> {
	const inputs = [
		{ entityId, content: "first input" },
		{ entityId, content: "second input" },
		{ entityId, content: "third input" },
	];

	const remembered = await client.rememberMany({ inputs });

	expect(remembered.map((memory) => memory.content)).toEqual(
		inputs.map((input) => input.content),
	);
	expect(new Set(remembered.map((memory) => memory.id)).size).toBe(
		inputs.length,
	);
}
