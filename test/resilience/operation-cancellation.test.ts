import { createMemory } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError, testScope } from "../helpers.js";

function createClient() {
	return createMemory({
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

		const [survivor, loser] = await client.addMany({
			scope: testScope("alice"),
			memories: [{ content: "survivor" }, { content: "loser" }],
		});
		if (!survivor || !loser) {
			throw new Error("Expected survivor and loser memories.");
		}
		const controller = new AbortController();
		controller.abort("cancel before work");

		await expectMnemocyteError(
			client.prune({ scope: testScope("alice"), signal: controller.signal }),
			"ABORTED",
		);
		await expectMnemocyteError(
			client.findDuplicates({
				scope: testScope("alice"),
				signal: controller.signal,
			}),
			"ABORTED",
		);
		await expectMnemocyteError(
			client.listAuditLog({
				scope: testScope("alice"),
				signal: controller.signal,
			}),
			"ABORTED",
		);
		await expectMnemocyteError(
			client.experimental.consolidate({
				scope: testScope("alice"),
				survivorId: survivor.id,
				supersededIds: [loser.id],
				signal: controller.signal,
			}),
			"ABORTED",
		);

		await expect(
			client.stats({ scope: testScope("alice") }),
		).resolves.toMatchObject({
			memoryCount: 2,
			supersededMemoryCount: 0,
		});
	});

	test("checks cancellation during an in-memory prune scan before deletion", async () => {
		const client = createClient();

		await client.addMany({
			scope: testScope("scan"),
			memories: Array.from({ length: 12 }, (_, index) => ({
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
			addEventListener: controller.signal.addEventListener.bind(
				controller.signal,
			),
			removeEventListener: controller.signal.removeEventListener.bind(
				controller.signal,
			),
		} as unknown as AbortSignal;

		await expectMnemocyteError(
			client.prune({
				scope: testScope("scan"),
				createdBefore: new Date(Date.now() + 60_000),
				signal,
			}),
			"ABORTED",
		);
		expect(abortChecks).toBeGreaterThanOrEqual(6);
		await expect(
			client.stats({ scope: testScope("scan") }),
		).resolves.toMatchObject({
			memoryCount: 12,
		});
	});
});
