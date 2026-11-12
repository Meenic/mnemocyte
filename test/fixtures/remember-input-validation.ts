import type {
	AddInput,
	Embedder,
	ImportanceLevel,
	MemoryClient,
	MemoryKind,
	PruneInput,
} from "mnemocyte";
import { expect } from "vitest";
import { expectMnemocyteError, testScope } from "../helpers.js";

const MEMORY_KINDS = [
	"fact",
	"preference",
	"instruction",
	"backstory",
	"episode",
	"session",
] as const satisfies readonly MemoryKind[];

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
): AddInput {
	return {
		scope: testScope(entityId),
		content: `invalid ${field}`,
		[field]: value,
	} as unknown as AddInput;
}

export async function verifyRememberInputValidation(
	client: MemoryClient,
	getEmbedCalls: () => number,
	entityId: string,
): Promise<void> {
	const invalidInputs = [
		invalidRememberInput(entityId, "kind", "bogus"),
		invalidRememberInput(entityId, "key", ""),
		invalidRememberInput(entityId, "key", 1),
		invalidRememberInput(entityId, "scope", { namespace: "test" }),
		invalidRememberInput(entityId, "scope", {
			namespace: "test",
			entityId,
			agentId: "",
		}),
		invalidRememberInput(entityId, "importance", "bogus"),
		invalidRememberInput(entityId, "tags", "not-an-array"),
		invalidRememberInput(entityId, "tags", ["valid", 1]),
		invalidRememberInput(entityId, "source", 42),
		invalidRememberInput(entityId, "source", null),
		invalidRememberInput(entityId, "expiresAt", "2030-01-01"),
		invalidRememberInput(entityId, "expiresAt", new Date("invalid")),
	];

	for (const input of invalidInputs) {
		await expectMnemocyteError(client.add(input), "VALIDATION");
		expect(getEmbedCalls()).toBe(0);
		await expect(
			client.stats({ scope: testScope(entityId) }),
		).resolves.toMatchObject({
			memoryCount: 0,
		});
	}

	await expectMnemocyteError(
		client.addMany({
			scope: testScope(entityId),
			memories: [
				{ content: "valid batch item" },
				invalidRememberInput(entityId, "importance", "bogus"),
			],
		}),
		"VALIDATION",
	);
	expect(getEmbedCalls()).toBe(0);
	await expect(
		client.stats({ scope: testScope(entityId) }),
	).resolves.toMatchObject({
		memoryCount: 0,
	});

	const expiresAt = new Date("2035-06-07T08:09:10.000Z");
	const remembered = await client.addMany({
		scope: testScope(entityId),
		memories: MEMORY_KINDS.map((kind, index) => ({
			content: `accepted ${kind}`,
			kind,
			importance:
				IMPORTANCE_LEVELS[index % IMPORTANCE_LEVELS.length] ?? "normal",
			tags: [" accepted ", "", "accepted"],
			source: "",
			expiresAt,
		})),
	});
	expect(remembered).toHaveLength(MEMORY_KINDS.length);
	expect(new Set(remembered.map((memory) => memory.kind))).toEqual(
		new Set(MEMORY_KINDS),
	);
	expect(new Set(remembered.map((memory) => memory.importance))).toEqual(
		new Set(IMPORTANCE_LEVELS),
	);
	for (const memory of remembered) {
		expect(memory.tags).toEqual(["accepted"]);
		expect(memory.source).toBe("");
		expect(memory.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
	}

	const recalled = await client.search({
		scope: testScope(entityId),
		query: "accepted",
		kinds: [...MEMORY_KINDS],
		limit: MEMORY_KINDS.length,
		minScore: 0,
	});
	expect(recalled).toHaveLength(MEMORY_KINDS.length);
	for (const memory of recalled) {
		expect(Number.isFinite(memory.score)).toBe(true);
		expect(Number.isFinite(memory.scores.importance)).toBe(true);
	}

	const callsBeforeInvalidRecall = getEmbedCalls();
	await expectMnemocyteError(
		client.search({
			scope: testScope(entityId),
			query: "invalid filter",
			kinds: ["bogus"] as unknown as MemoryKind[],
		}),
		"VALIDATION",
	);
	expect(getEmbedCalls()).toBe(callsBeforeInvalidRecall);

	await expectMnemocyteError(
		client.findDuplicates({
			scope: testScope(entityId),
			kinds: ["bogus"] as unknown as MemoryKind[],
		}),
		"VALIDATION",
	);
	await expectMnemocyteError(
		client.prune({
			scope: testScope(entityId),
			kinds: ["bogus"],
			dryRun: true,
		} as unknown as PruneInput),
		"VALIDATION",
	);
}
