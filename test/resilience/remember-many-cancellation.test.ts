import { createMemory } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError, testScope } from "../helpers.js";

describe("addMany cancellation", () => {
	test("cancels the entire batch through its explicit signal", async () => {
		let markProviderStarted: (() => void) | undefined;
		const providerStarted = new Promise<void>((resolve) => {
			markProviderStarted = resolve;
		});
		const client = createMemory({
			embedder: {
				model: "batch-cancellation-test",
				dimensions: 1,
				async embed(_texts, options) {
					markProviderStarted?.();
					if (!options.signal) {
						throw new Error("Expected a batch signal.");
					}
					return new Promise<number[][]>((_resolve, reject) => {
						options.signal?.addEventListener(
							"abort",
							() => {
								reject(
									Object.assign(new Error("Aborted"), { name: "AbortError" }),
								);
							},
							{ once: true },
						);
					});
				},
			},
		});
		const controller = new AbortController();

		const pending = client.addMany({
			scope: testScope("alice"),
			memories: [{ content: "first" }, { content: "second" }],
			signal: controller.signal,
		});
		await providerStarted;
		controller.abort();

		await expectMnemocyteError(pending, "ABORTED");
		await expect(
			client.stats({ scope: testScope("alice") }),
		).resolves.toMatchObject({
			memoryCount: 0,
		});
	});

	test("forwards the batch signal to the embedder", async () => {
		let providerSignal: AbortSignal | undefined;
		const client = createMemory({
			embedder: {
				model: "batch-signal-ownership-test",
				dimensions: 1,
				async embed(texts, options) {
					providerSignal = options.signal;
					return texts.map(() => [1]);
				},
			},
		});
		const batchController = new AbortController();

		const memories = await client.addMany({
			scope: testScope("alice"),
			memories: [{ content: "item" }],
			signal: batchController.signal,
		});
		expect(memories).toHaveLength(1);
		expect(providerSignal?.aborted).toBe(false);
	});
});
