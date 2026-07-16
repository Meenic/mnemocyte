import { createMnemocyte } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

function createClient() {
	return createMnemocyte({
		embedder: {
			model: "operation-cancellation-test",
			dimensions: 2,
			async embed(texts) {
				return texts.map((text) => [text.length, 1]);
			},
		},
		audit: { enabled: true },
	});
}

describe("operation cancellation", () => {
	test("pre-aborted maintenance operations reject before store work", async () => {
		const client = createClient();

		try {
			const [survivor, loser] = await client.rememberMany({
				inputs: [
					{ entityId: "alice", content: "survivor" },
					{ entityId: "alice", content: "loser" },
				],
			});
			if (!survivor || !loser) {
				throw new Error("Expected survivor and loser memories.");
			}
			const controller = new AbortController();
			controller.abort("cancel before work");

			await expectMnemocyteError(
				client.prune({ entityId: "alice", signal: controller.signal }),
				"ABORTED",
			);
			await expectMnemocyteError(
				client.findDuplicates({
					entityId: "alice",
					signal: controller.signal,
				}),
				"ABORTED",
			);
			await expectMnemocyteError(
				client.listAuditLog({
					entityId: "alice",
					signal: controller.signal,
				}),
				"ABORTED",
			);
			await expectMnemocyteError(
				client.experimental.consolidate({
					entityId: "alice",
					survivorId: survivor.id,
					supersededIds: [loser.id],
					signal: controller.signal,
				}),
				"ABORTED",
			);

			await expect(client.stats({ entityId: "alice" })).resolves.toMatchObject({
				memoryCount: 2,
				supersededMemoryCount: 0,
			});
		} finally {
			await client.close();
		}
	});

	test("checks cancellation during an in-memory prune scan before deletion", async () => {
		const client = createClient();

		try {
			await client.rememberMany({
				inputs: Array.from({ length: 12 }, (_, index) => ({
					entityId: "scan",
					content: `memory ${index}`,
				})),
			});
			const controller = new AbortController();
			let abortChecks = 0;
			const signal = {
				get aborted() {
					abortChecks += 1;
					if (abortChecks === 6) {
						controller.abort("cancel during scan");
					}
					return controller.signal.aborted;
				},
				get reason() {
					return controller.signal.reason;
				},
			} as unknown as AbortSignal;

			await expectMnemocyteError(
				client.prune({ entityId: "scan", signal }),
				"ABORTED",
			);
			expect(abortChecks).toBeGreaterThanOrEqual(6);
			await expect(client.stats({ entityId: "scan" })).resolves.toMatchObject({
				memoryCount: 12,
			});
		} finally {
			await client.close();
		}
	});
});
