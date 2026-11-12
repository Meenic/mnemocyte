import {
	type AddInput,
	type AddManyInput,
	createMemory,
	isMnemocyteError,
	type JsonObject,
	type MnemocyteObservation,
	type MnemocyteOperation,
	type NewMemory,
} from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError, testScope } from "../helpers.js";

describe("observability hooks", () => {
	test("emits lifecycle events for operations", async () => {
		const events: MnemocyteObservation[] = [];
		const client = createMemory({
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

		const memory = await client.add({
			scope: testScope(entityId),
			content: "Observe successful operations.",
		});
		await client.search({
			scope: testScope(entityId),
			query: "successful operations",
			limit: 1,
		});
		await client.context({
			scope: testScope(entityId),
			query: "successful operations",
			limit: 1,
		});

		await expectMnemocyteError(
			client.delete({ scope: testScope(entityId), id: "missing" }),
			"NOT_FOUND",
		);

		await client.delete({ scope: testScope(entityId), id: memory.id });

		const rememberEvents = events.filter((event) => event.operation === "add");
		expect(rememberEvents[0]?.phase).toBe("start");
		expect(rememberEvents[1]?.phase).toBe("success");
		expect(rememberEvents[0]?.backend).toBe("in-memory");
		expect(rememberEvents[0]?.entityId).toBe(entityId);
		expect(rememberEvents[1]?.count).toBe(1);
		expect(rememberEvents[1]?.memoryId !== undefined).toBe(true);
		expect(typeof rememberEvents[1]?.durationMs).toBe("number");

		const recallSuccess = events.find(
			(event) => event.operation === "search" && event.phase === "success",
		);
		expect(recallSuccess?.count).toBe(1);

		const errorEvent = events.find(
			(event) => event.operation === "delete" && event.phase === "error",
		);
		expect(errorEvent?.namespace).toBe("test");
		expect(errorEvent?.entityId).toBe(entityId);
		expect(errorEvent?.memoryId).toBe("missing");
		expect(isMnemocyteError(errorEvent?.error)).toBe(true);
	});

	test("observes add preparation and validation failures", async () => {
		const events: MnemocyteObservation[] = [];
		let inputToMutate: AddInput | undefined;
		const client = createMemory({
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
						event.operation === "add" &&
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
			expectedMetadata: {
				namespace?: string;
				entityId?: string;
				count?: number;
			},
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
			"add",
			() =>
				client.add({
					scope: testScope("cyclic_single"),
					content: "invalid metadata",
					metadata: cyclicSingle as JsonObject,
				}),
			"VALIDATION",
			{ namespace: "test", entityId: "cyclic_single" },
		);

		const cyclicBatch: Record<string, unknown> = {};
		cyclicBatch.self = cyclicBatch;
		await expectObservedFailure(
			"addMany",
			() =>
				client.addMany({
					scope: testScope("cyclic_batch"),
					memories: [
						{
							content: "invalid metadata",
							metadata: cyclicBatch as JsonObject,
						},
					],
				}),
			"VALIDATION",
			{ count: 1 },
		);

		await expectObservedFailure(
			"add",
			() =>
				client.add({
					scope: testScope("invalid_single"),
					content: "invalid kind",
					kind: "bogus",
				} as unknown as AddInput),
			"VALIDATION",
			{ namespace: "test", entityId: "invalid_single" },
		);
		await expectObservedFailure(
			"addMany",
			() =>
				client.addMany({
					scope: testScope("invalid_batch"),
					memories: [
						{
							content: "invalid importance",
							importance: "bogus",
						} as unknown as NewMemory,
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
			scope: testScope("hook_snapshot"),
			content: "snapshot before hook",
			tags: mutableTags,
			metadata: mutableMetadata,
			expiresAt: mutableExpiresAt,
		};
		const remembered = await client.add(inputToMutate);
		inputToMutate = undefined;
		expect(remembered.tags).toEqual(["original"]);
		expect(remembered.expiresAt?.toISOString()).toBe(
			"2030-01-01T00:00:00.000Z",
		);
		expect(remembered.metadata).toEqual({ nested: { value: "original" } });
		await expectObservedFailure(
			"addMany",
			() =>
				client.addMany({
					scope: { namespace: "test" },
					memories: [{ content: "missing entity" }],
				} as unknown as AddManyInput),
			"VALIDATION",
			{ namespace: "test", count: 1 },
		);
	});
});
