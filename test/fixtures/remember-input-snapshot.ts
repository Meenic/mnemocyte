import type {
	Embedder,
	JsonObject,
	MnemocyteClient,
	RememberInput,
} from "mnemocyte";
import { expect } from "vitest";

interface PendingEmbeddingCall {
	release: () => void;
}

export function createGatedEmbedder(
	model: string,
	dimensions: number,
): {
	embedder: Embedder;
	nextCall: () => Promise<PendingEmbeddingCall>;
} {
	const queuedCalls: PendingEmbeddingCall[] = [];
	const waiters: ((call: PendingEmbeddingCall) => void)[] = [];

	return {
		embedder: {
			model,
			dimensions,
			async embed(texts) {
				let release: (() => void) | undefined;
				const released = new Promise<void>((resolve) => {
					release = resolve;
				});
				const call = {
					release() {
						release?.();
					},
				};
				const waiter = waiters.shift();
				if (waiter) {
					waiter(call);
				} else {
					queuedCalls.push(call);
				}
				await released;
				return texts.map(() => [
					1,
					...Array.from({ length: dimensions - 1 }, () => 0),
				]);
			},
		},
		nextCall() {
			const queued = queuedCalls.shift();
			if (queued) {
				return Promise.resolve(queued);
			}
			return new Promise<PendingEmbeddingCall>((resolve) => {
				waiters.push(resolve);
			});
		},
	};
}

function nestedValue(metadata: JsonObject): JsonObject {
	const nested = metadata.nested;
	if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
		throw new Error("Expected nested metadata object.");
	}
	return nested;
}

export async function verifyRememberInputSnapshots(
	client: MnemocyteClient,
	nextEmbeddingCall: () => Promise<PendingEmbeddingCall>,
	entityId: string,
): Promise<void> {
	const singleMetadata = { nested: { value: "single-original" } };
	const singleTags = ["single-original", "shared"];
	const singleExpiresAt = new Date("2030-01-02T03:04:05.000Z");
	const singleInput: RememberInput = {
		entityId,
		content: "single original content",
		type: "fact",
		importance: "high",
		tags: singleTags,
		source: "single-original",
		metadata: singleMetadata,
		confidence: 0.75,
		expiresAt: singleExpiresAt,
	};

	const pendingSingle = client.remember(singleInput);
	const singleEmbedding = await nextEmbeddingCall();
	singleInput.content = "single mutated content";
	singleInput.type = "session";
	singleInput.importance = "low";
	singleInput.source = "single-mutated";
	singleInput.confidence = 0.1;
	singleTags[0] = "single-mutated";
	singleMetadata.nested.value = "single-mutated";
	singleExpiresAt.setUTCFullYear(2040);
	singleEmbedding.release();

	const single = await pendingSingle;
	expect(single).toMatchObject({
		entityId,
		content: "single original content",
		type: "fact",
		importance: "high",
		tags: ["single-original", "shared"],
		source: "single-original",
		confidence: 0.75,
	});
	expect(nestedValue(single.metadata).value).toBe("single-original");
	expect(single.expiresAt?.toISOString()).toBe("2030-01-02T03:04:05.000Z");

	const batchMetadata = { nested: { value: "batch-original" } };
	const batchTags = ["batch-original", "shared"];
	const batchExpiresAt = new Date("2031-02-03T04:05:06.000Z");
	const batchInputs: RememberInput[] = [
		{
			entityId,
			content: "batch original content",
			type: "instruction",
			importance: "critical",
			tags: batchTags,
			source: "batch-original",
			metadata: batchMetadata,
			confidence: 0.9,
			expiresAt: batchExpiresAt,
		},
	];

	const pendingBatch = client.rememberMany({ inputs: batchInputs });
	const batchEmbedding = await nextEmbeddingCall();
	const firstBatchInput = batchInputs[0];
	if (!firstBatchInput) {
		throw new Error("Expected first batch input.");
	}
	firstBatchInput.content = "batch mutated content";
	firstBatchInput.type = "episode";
	firstBatchInput.importance = "normal";
	firstBatchInput.source = "batch-mutated";
	firstBatchInput.confidence = 0.2;
	batchTags[0] = "batch-mutated";
	batchMetadata.nested.value = "batch-mutated";
	batchExpiresAt.setUTCFullYear(2041);
	batchInputs.push({
		entityId,
		content: "added after invocation",
	});
	batchEmbedding.release();

	const batch = await pendingBatch;
	expect(batch).toHaveLength(1);
	expect(batch[0]).toMatchObject({
		entityId,
		content: "batch original content",
		type: "instruction",
		importance: "critical",
		tags: ["batch-original", "shared"],
		source: "batch-original",
		confidence: 0.9,
	});
	expect(nestedValue(batch[0]?.metadata ?? {}).value).toBe("batch-original");
	expect(batch[0]?.expiresAt?.toISOString()).toBe("2031-02-03T04:05:06.000Z");
}
