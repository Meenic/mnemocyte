import { createMnemocyte, type RememberInput } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

describe("rememberMany cancellation", () => {
	test("cancels the entire batch through its explicit signal", async () => {
		let markProviderStarted: (() => void) | undefined;
		const providerStarted = new Promise<void>((resolve) => {
			markProviderStarted = resolve;
		});
		const client = createMnemocyte({
			embedder: {
				model: "batch-cancellation-test",
				dimensions: 1,
				async embed(_texts, options = {}) {
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

		try {
			const pending = client.rememberMany({
				inputs: [
					{ entityId: "alice", content: "first" },
					{ entityId: "alice", content: "second" },
				],
				signal: controller.signal,
			});
			await providerStarted;
			controller.abort();

			await expectMnemocyteError(pending, "ABORTED");
			await expect(client.stats({ entityId: "alice" })).resolves.toMatchObject({
				memoryCount: 0,
			});
		} finally {
			await client.close();
		}
	});

	test("uses the batch signal instead of signals carried by item values", async () => {
		let providerSignal: AbortSignal | undefined;
		const client = createMnemocyte({
			embedder: {
				model: "batch-signal-ownership-test",
				dimensions: 1,
				async embed(texts, options = {}) {
					providerSignal = options.signal;
					return texts.map(() => [1]);
				},
			},
		});
		const itemController = new AbortController();
		itemController.abort();
		const item: RememberInput = {
			entityId: "alice",
			content: "item with a legacy signal",
			signal: itemController.signal,
		};
		const batchController = new AbortController();

		try {
			const memories = await client.rememberMany({
				inputs: [item],
				signal: batchController.signal,
			});
			expect(memories).toHaveLength(1);
			expect(providerSignal?.aborted).toBe(false);
		} finally {
			await client.close();
		}
	});
});
