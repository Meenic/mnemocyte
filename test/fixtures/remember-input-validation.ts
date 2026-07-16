import type {
	Embedder,
	ImportanceLevel,
	MemoryType,
	MnemocyteClient,
	PruneInput,
	RememberInput,
} from "mnemocyte";
import { expect } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

const MEMORY_TYPES = [
	"fact",
	"preference",
	"instruction",
	"backstory",
	"episode",
	"session",
] as const satisfies readonly MemoryType[];

const IMPORTANCE_LEVELS = [
	"low",
	"normal",
	"high",
	"critical",
] as const satisfies readonly ImportanceLevel[];

export function createCountingEmbedder(
	model: string,
	dimensions: number,
): {
	embedder: Embedder;
	getCalls: () => number;
} {
	let calls = 0;
	return {
		embedder: {
			model,
			dimensions,
			async embed(texts) {
				calls += 1;
				return texts.map(() => [
					1,
					...Array.from({ length: dimensions - 1 }, () => 0),
				]);
			},
		},
		getCalls() {
			return calls;
		},
	};
}

function invalidRememberInput(
	entityId: string,
	field: string,
	value: unknown,
): RememberInput {
	return {
		entityId,
		content: `invalid ${field}`,
		[field]: value,
	} as unknown as RememberInput;
}

export async function verifyRememberInputValidation(
	client: MnemocyteClient,
	getEmbedCalls: () => number,
	entityId: string,
): Promise<void> {
	const invalidInputs = [
		invalidRememberInput(entityId, "type", "bogus"),
		invalidRememberInput(entityId, "importance", "bogus"),
		invalidRememberInput(entityId, "tags", "not-an-array"),
		invalidRememberInput(entityId, "tags", ["valid", 1]),
		invalidRememberInput(entityId, "source", 42),
		invalidRememberInput(entityId, "source", null),
		invalidRememberInput(entityId, "expiresAt", "2030-01-01"),
		invalidRememberInput(entityId, "expiresAt", new Date("invalid")),
	];

	for (const input of invalidInputs) {
		await expectMnemocyteError(client.remember(input), "VALIDATION");
		expect(getEmbedCalls()).toBe(0);
		await expect(client.stats({ entityId })).resolves.toMatchObject({
			memoryCount: 0,
		});
	}

	await expectMnemocyteError(
		client.rememberMany({
			inputs: [
				{ entityId, content: "valid batch item" },
				invalidRememberInput(entityId, "importance", "bogus"),
			],
		}),
		"VALIDATION",
	);
	expect(getEmbedCalls()).toBe(0);
	await expect(client.stats({ entityId })).resolves.toMatchObject({
		memoryCount: 0,
	});

	const expiresAt = new Date("2035-06-07T08:09:10.000Z");
	const remembered = await client.rememberMany({
		inputs: MEMORY_TYPES.map((type, index) => ({
			entityId,
			content: `accepted ${type}`,
			type,
			importance:
				IMPORTANCE_LEVELS[index % IMPORTANCE_LEVELS.length] ?? "normal",
			tags: [" accepted ", "", "accepted"],
			source: "",
			expiresAt,
		})),
	});
	expect(remembered).toHaveLength(MEMORY_TYPES.length);
	expect(new Set(remembered.map((memory) => memory.type))).toEqual(
		new Set(MEMORY_TYPES),
	);
	expect(new Set(remembered.map((memory) => memory.importance))).toEqual(
		new Set(IMPORTANCE_LEVELS),
	);
	for (const memory of remembered) {
		expect(memory.tags).toEqual(["accepted"]);
		expect(memory.source).toBe("");
		expect(memory.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
	}

	const recalled = await client.recall({
		entityId,
		query: "accepted",
		types: [...MEMORY_TYPES],
		limit: MEMORY_TYPES.length,
		minScore: 0,
	});
	expect(recalled).toHaveLength(MEMORY_TYPES.length);
	for (const memory of recalled) {
		expect(Number.isFinite(memory.score)).toBe(true);
		expect(Number.isFinite(memory.scores.importance)).toBe(true);
	}

	const callsBeforeInvalidRecall = getEmbedCalls();
	await expectMnemocyteError(
		client.recall({
			entityId,
			query: "invalid filter",
			types: ["bogus"] as unknown as MemoryType[],
		}),
		"VALIDATION",
	);
	expect(getEmbedCalls()).toBe(callsBeforeInvalidRecall);

	await expectMnemocyteError(
		client.findDuplicates({
			entityId,
			types: ["bogus"] as unknown as MemoryType[],
		}),
		"VALIDATION",
	);
	await expectMnemocyteError(
		client.prune({
			entityId,
			types: ["bogus"],
			dryRun: true,
		} as unknown as PruneInput),
		"VALIDATION",
	);
}
