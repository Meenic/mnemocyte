import {
	createMnemocyte,
	isMnemocyteError,
	type JsonObject,
	type MnemocyteObservation,
	type MnemocyteOperation,
	type RememberInput,
} from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

describe("observability hooks", () => {
	test("emits lifecycle events for operations", async () => {
		const events: MnemocyteObservation[] = [];
		const client = createMnemocyte({
			embedder: {
				model: "observability-test",
				dimensions: 2,
				async embed(texts) {
					return texts.map((text) => [text.length, 1]);
				},
			},
			observability: {
				onEvent(event) {
					events.push(event);
				},
			},
		});
		const entityId = `observability_${Date.now()}_${Math.random().toString(36).slice(2)}`;

		try {
			const memory = await client.remember({
				entityId,
				content: "Observe successful operations.",
			});
			await client.recall({
				entityId,
				query: "successful operations",
				limit: 1,
			});
			await client.buildContext({
				entityId,
				query: "successful operations",
				limit: 1,
			});

			await expectMnemocyteError(
				client.forget({ entityId, memoryId: "missing" }),
				"NOT_FOUND",
			);

			await client.forget({ entityId, memoryId: memory.id });
		} finally {
			await client.close();
		}

		const rememberEvents = events.filter(
			(event) => event.operation === "remember",
		);
		expect(rememberEvents[0]?.phase).toBe("start");
		expect(rememberEvents[1]?.phase).toBe("success");
		expect(rememberEvents[0]?.backend).toBe("in-memory");
		expect(rememberEvents[0]?.entityId).toBe(entityId);
		expect(rememberEvents[1]?.count).toBe(1);
		expect(rememberEvents[1]?.memoryId !== undefined).toBe(true);
		expect(typeof rememberEvents[1]?.durationMs).toBe("number");

		const recallSuccess = events.find(
			(event) => event.operation === "recall" && event.phase === "success",
		);
		expect(recallSuccess?.count).toBe(1);

		const errorEvent = events.find(
			(event) => event.operation === "forget" && event.phase === "error",
		);
		expect(errorEvent?.entityId).toBe(entityId);
		expect(errorEvent?.memoryId).toBe("missing");
		expect(isMnemocyteError(errorEvent?.error)).toBe(true);

		const closeSuccess = events.find(
			(event) => event.operation === "close" && event.phase === "success",
		);
		expect(closeSuccess?.backend).toBe("in-memory");
	});

	test("observes remember preparation, validation, and closed-client failures", async () => {
		const events: MnemocyteObservation[] = [];
		let inputToMutate: RememberInput | undefined;
		const client = createMnemocyte({
			embedder: {
				model: "observability-failure-test",
				dimensions: 1,
				async embed(texts) {
					return texts.map(() => [1]);
				},
			},
			observability: {
				onEvent(event) {
					events.push(event);
					if (
						event.operation === "remember" &&
						event.phase === "start" &&
						inputToMutate
					) {
						inputToMutate.tags?.splice(0, 1, "mutated-by-hook");
						inputToMutate.expiresAt?.setUTCFullYear(2040);
						const nested = inputToMutate.metadata?.nested;
						if (
							nested !== null &&
							typeof nested === "object" &&
							!Array.isArray(nested)
						) {
							nested.value = "mutated-by-hook";
						}
					}
				},
			},
		});

		async function expectObservedFailure(
			operation: MnemocyteOperation,
			invoke: () => Promise<unknown>,
			code: "DB" | "VALIDATION",
			expectedMetadata: { entityId?: string; count?: number },
		): Promise<void> {
			events.length = 0;
			const error = await expectMnemocyteError(invoke(), code);
			const operationEvents = events.filter(
				(event) => event.operation === operation,
			);
			expect(operationEvents.map((event) => event.phase)).toEqual([
				"start",
				"error",
			]);
			expect(operationEvents[1]?.error).toBe(error);
			expect(operationEvents[0]).toMatchObject(expectedMetadata);
			expect(operationEvents[1]).toMatchObject(expectedMetadata);
		}

		const cyclicSingle: Record<string, unknown> = {};
		cyclicSingle.self = cyclicSingle;
		await expectObservedFailure(
			"remember",
			() =>
				client.remember({
					entityId: "cyclic_single",
					content: "invalid metadata",
					metadata: cyclicSingle as JsonObject,
				}),
			"VALIDATION",
			{ entityId: "cyclic_single" },
		);

		const cyclicBatch: Record<string, unknown> = {};
		cyclicBatch.self = cyclicBatch;
		await expectObservedFailure(
			"rememberMany",
			() =>
				client.rememberMany({
					inputs: [
						{
							entityId: "cyclic_batch",
							content: "invalid metadata",
							metadata: cyclicBatch as JsonObject,
						},
					],
				}),
			"VALIDATION",
			{ count: 1 },
		);

		await expectObservedFailure(
			"remember",
			() =>
				client.remember({
					entityId: "invalid_single",
					content: "invalid type",
					type: "bogus",
				} as unknown as RememberInput),
			"VALIDATION",
			{ entityId: "invalid_single" },
		);
		await expectObservedFailure(
			"rememberMany",
			() =>
				client.rememberMany({
					inputs: [
						{
							entityId: "invalid_batch",
							content: "invalid importance",
							importance: "bogus",
						} as unknown as RememberInput,
					],
				}),
			"VALIDATION",
			{ count: 1 },
		);

		const mutableMetadata = {
			nested: { value: "original" },
		} satisfies JsonObject;
		const mutableTags = ["original"];
		const mutableExpiresAt = new Date("2030-01-01T00:00:00.000Z");
		inputToMutate = {
			entityId: "hook_snapshot",
			content: "snapshot before hook",
			tags: mutableTags,
			metadata: mutableMetadata,
			expiresAt: mutableExpiresAt,
		};
		const remembered = await client.remember(inputToMutate);
		inputToMutate = undefined;
		expect(remembered.tags).toEqual(["original"]);
		expect(remembered.expiresAt?.toISOString()).toBe(
			"2030-01-01T00:00:00.000Z",
		);
		expect(remembered.metadata).toEqual({ nested: { value: "original" } });

		await client.close();

		const closedCyclicSingle: Record<string, unknown> = {};
		closedCyclicSingle.self = closedCyclicSingle;
		await expectObservedFailure(
			"remember",
			() =>
				client.remember({
					entityId: "closed_single",
					content: "closed invalid metadata",
					metadata: closedCyclicSingle as JsonObject,
				}),
			"DB",
			{ entityId: "closed_single" },
		);

		const closedCyclicBatch: Record<string, unknown> = {};
		closedCyclicBatch.self = closedCyclicBatch;
		await expectObservedFailure(
			"rememberMany",
			() =>
				client.rememberMany({
					inputs: [
						{
							entityId: "closed_batch",
							content: "closed invalid metadata",
							metadata: closedCyclicBatch as JsonObject,
						},
					],
				}),
			"DB",
			{ count: 1 },
		);
	});
});
