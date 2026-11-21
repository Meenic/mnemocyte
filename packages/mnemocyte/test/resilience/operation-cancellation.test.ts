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

/** A signal that aborts on its `abortAt`-th `aborted` read, mid-scan. */
function abortOnCheck(
	abortAt: number,
	reason: string,
): { signal: AbortSignal; checks: () => number } {
	const controller = new AbortController();
	let checks = 0;
	const signal = {
		get aborted() {
			checks += 1;
			if (checks === abortAt) {
				controller.abort(reason);
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
	return { signal, checks: () => checks };
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
			client.consolidate({
				scope: testScope("alice"),
				survivorId: survivor.id,
				supersededIds: [loser.id],
				signal: controller.signal,
			}),
			"ABORTED",
		);

		await expectMnemocyteError(
			client.stats({ scope: testScope("alice"), signal: controller.signal }),
			"ABORTED",
		);
		await expectMnemocyteError(
			client.stats({ allNamespaces: true, signal: controller.signal }),
			"ABORTED",
		);
		await expectMnemocyteError(
			client.for(testScope("alice")).stats({ signal: controller.signal }),
			"ABORTED",
		);

		await expect(
			client.stats({ scope: testScope("alice") }),
		).resolves.toMatchObject({
			memoryCount: 2,
			supersededMemoryCount: 0,
		});
	});

	test.each(["unbound", "bound"])(
		"checks cancellation during an in-memory stats scan (%s)",
		async (kind) => {
			const client = createClient();
			await client.addMany({
				scope: testScope("stats"),
				memories: Array.from({ length: 12 }, (_, index) => ({
					content: `memory ${index}`,
				})),
			});
			const { signal, checks } = abortOnCheck(6, "cancel during stats");

			await expectMnemocyteError(
				kind === "bound"
					? client.for(testScope("stats")).stats({ signal })
					: client.stats({ scope: testScope("stats"), signal }),
				"ABORTED",
			);
			expect(checks()).toBeGreaterThanOrEqual(6);
		},
	);

	test("checks cancellation during an in-memory prune scan before deletion", async () => {
		const client = createClient();

		await client.addMany({
			scope: testScope("scan"),
			memories: Array.from({ length: 12 }, (_, index) => ({
				content: `memory ${index}`,
			})),
		});
		const { signal, checks } = abortOnCheck(6, "cancel during scan");

		await expectMnemocyteError(
			client.prune({
				scope: testScope("scan"),
				createdBefore: new Date(Date.now() + 60_000),
				signal,
			}),
			"ABORTED",
		);
		expect(checks()).toBeGreaterThanOrEqual(6);
		await expect(
			client.stats({ scope: testScope("scan") }),
		).resolves.toMatchObject({
			memoryCount: 12,
		});
	});
});
