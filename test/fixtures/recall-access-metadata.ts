import type { Memory, MnemocyteClient } from "mnemocyte";
import { expect } from "vitest";
import { expectDefined } from "../helpers.js";

export interface StoredAccessState {
	id: string;
	accessCount: number;
	lastAccessedAt: Date | null;
	updatedAt: Date;
}

export async function verifyRecallAccessMetadata(
	client: MnemocyteClient,
	entityId: string,
	readStoredState: (
		memories: readonly Memory[],
	) => Promise<readonly StoredAccessState[]>,
): Promise<void> {
	const created = await client.rememberMany({
		inputs: [
			{ entityId, content: "shared access first" },
			{ entityId, content: "shared access second" },
		],
	});

	const first = await client.recall({
		entityId,
		query: "shared access",
		limit: 2,
		explain: true,
	});
	expect(first).toHaveLength(2);
	for (const memory of first) {
		expect(memory.accessCount).toBe(1);
		expect(memory.lastAccessedAt).toBeInstanceOf(Date);
		expect(memory.scores.access).toBe(0);
		expect(memory.explanation?.accessScore).toBe(0);
		expect(memory.updatedAt).toEqual(memory.lastAccessedAt);
	}

	const firstStored = new Map(
		(await readStoredState(created)).map((memory) => [memory.id, memory]),
	);
	for (const memory of first) {
		const stored = expectDefined(firstStored.get(memory.id));
		expect(stored.accessCount).toBe(memory.accessCount);
		expect(stored.lastAccessedAt).toEqual(memory.lastAccessedAt);
		expect(stored.updatedAt).toEqual(memory.updatedAt);
	}

	await new Promise((resolve) => setTimeout(resolve, 5));

	const second = await client.recall({
		entityId,
		query: "shared access",
		limit: 2,
		explain: true,
	});
	const preSecondRecallAccessScore = Math.log1p(1) / Math.log1p(10);
	expect(second).toHaveLength(2);
	for (const memory of second) {
		expect(memory.accessCount).toBe(2);
		expect(memory.lastAccessedAt).toBeInstanceOf(Date);
		expect(memory.scores.access).toBeCloseTo(preSecondRecallAccessScore, 12);
		expect(memory.explanation?.accessScore).toBeCloseTo(
			preSecondRecallAccessScore,
			12,
		);
		expect(memory.updatedAt).toEqual(memory.lastAccessedAt);
	}

	const secondStored = new Map(
		(await readStoredState(created)).map((memory) => [memory.id, memory]),
	);
	for (const memory of second) {
		const stored = expectDefined(secondStored.get(memory.id));
		expect(stored.accessCount).toBe(memory.accessCount);
		expect(stored.lastAccessedAt).toEqual(memory.lastAccessedAt);
		expect(stored.updatedAt).toEqual(memory.updatedAt);
	}
}
