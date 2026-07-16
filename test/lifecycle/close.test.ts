import { createMnemocyte, type MnemocyteObservation } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { createMemoryClient } from "../../src/memory/client-core.js";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import { expectMnemocyteError } from "../helpers.js";

describe("lifecycle", () => {
	test("rejects operations after close and validates config", async () => {
		function createClient() {
			return createMnemocyte({
				embedder: {
					model: "lifecycle-test",
					dimensions: 2,
					async embed(texts) {
						return texts.map((text) => [text.length, 1]);
					},
				},
			});
		}

		async function expectClosed(action: () => Promise<unknown>) {
			await expectMnemocyteError(action(), "DB");
		}

		// 1. close() is idempotent and does not throw.
		{
			const client = createClient();
			await client.remember({ entityId: "alice", content: "hello" });
			await client.close();
			await client.close();
		}

		// 2. Every public mutating / reading method rejects with code "DB" after close.
		{
			const client = createClient();
			await client.remember({ entityId: "alice", content: "hello" });
			await client.close();

			await expectClosed(() =>
				client.remember({ entityId: "alice", content: "later" }),
			);
			await expectClosed(() =>
				client.rememberMany([{ entityId: "alice", content: "later" }]),
			);
			await expectClosed(() =>
				client.recall({ entityId: "alice", query: "hi" }),
			);
			await expectClosed(() =>
				client.buildContext({ entityId: "alice", query: "hi" }),
			);
			await expectClosed(() =>
				client.forget({ entityId: "alice", memoryId: "mem_nope" }),
			);
			await expectClosed(() => client.forgetAll({ entityId: "alice" }));
			await expectClosed(() => client.prune({ entityId: "alice" }));
			await expectClosed(() => client.findDuplicates({ entityId: "alice" }));
			await expectClosed(() => client.listAuditLog({ entityId: "alice" }));
			await expectClosed(() =>
				client.experimental.consolidate({
					entityId: "alice",
					survivorId: "mem_nope",
					supersededIds: ["mem_other"],
				}),
			);
			await expectClosed(() => client.stats());
		}

		// 3. createMnemocyte keeps Postgres construction synchronous and defers
		// schema validation until the first operation.
		{
			const client = createMnemocyte({
				databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/none",
				embedder: {
					model: "custom-dims",
					dimensions: 768,
					async embed(texts) {
						return texts.map(() => [0]);
					},
				},
			});
			await client.close();
		}

		// 4. Observability still fires for close() and is then quiet for the rejected calls.
		{
			const events: MnemocyteObservation[] = [];
			const client = createMnemocyte({
				embedder: {
					model: "lifecycle-events",
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
			await client.close();
			const closeSuccess = events.find(
				(event) => event.operation === "close" && event.phase === "success",
			);
			expect(closeSuccess?.backend).toBe("in-memory");
			await expectMnemocyteError(
				client.remember({ entityId: "alice", content: "x" }),
				"DB",
			);
			const errorEvent = events.find(
				(event) => event.operation === "remember" && event.phase === "error",
			);
			expect(errorEvent?.backend).toBe("in-memory");
		}
	});

	test("waits for in-flight operations and rejects new work while closing", async () => {
		let releaseEmbedder: (() => void) | undefined;
		let resolveEmbedderStarted: (() => void) | undefined;
		const embedderStarted = new Promise<void>((resolve) => {
			resolveEmbedderStarted = resolve;
		});
		const baseStore = createInMemoryStore();
		let storeCloseStarted = false;
		const store = {
			...baseStore,
			async insertMemories(
				memories: Parameters<typeof baseStore.insertMemories>[0],
			) {
				expect(storeCloseStarted).toBe(false);
				return baseStore.insertMemories(memories);
			},
			async close() {
				storeCloseStarted = true;
				await baseStore.close();
			},
		};
		const client = createMemoryClient(
			{
				embedder: {
					model: "lifecycle-in-flight",
					dimensions: 1,
					async embed() {
						resolveEmbedderStarted?.();
						return new Promise<number[][]>((resolve) => {
							releaseEmbedder = () => resolve([[1]]);
						});
					},
				},
			},
			store,
		);

		const rememberPromise = client.remember({
			entityId: "alice",
			content: "complete before close",
		});
		await embedderStarted;

		const firstClose = client.close();
		const concurrentClose = client.close();
		expect(concurrentClose).toBe(firstClose);
		let closeSettled = false;
		void firstClose.then(() => {
			closeSettled = true;
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(closeSettled).toBe(false);
		expect(storeCloseStarted).toBe(false);
		await expectMnemocyteError(client.stats(), "DB");

		releaseEmbedder?.();
		await expect(rememberPromise).resolves.toMatchObject({
			content: "complete before close",
		});
		await firstClose;

		expect(storeCloseStarted).toBe(true);
		await expectMnemocyteError(client.stats(), "DB");
	});

	test("reopens admission after store close fails so close can be retried", async () => {
		const baseStore = createInMemoryStore();
		let closeAttempts = 0;
		const store = {
			...baseStore,
			async close() {
				closeAttempts += 1;
				if (closeAttempts === 1) {
					throw new Error("close failed");
				}
				await baseStore.close();
			},
		};
		const client = createMemoryClient(
			{
				embedder: {
					model: "lifecycle-close-retry",
					dimensions: 1,
					async embed(texts) {
						return texts.map(() => [1]);
					},
				},
			},
			store,
		);

		const failedClose = client.close();
		expect(client.close()).toBe(failedClose);
		await expect(failedClose).rejects.toThrow("close failed");
		await expect(client.stats()).resolves.toMatchObject({ memoryCount: 0 });

		const retryClose = client.close();
		expect(retryClose).not.toBe(failedClose);
		expect(client.close()).toBe(retryClose);
		await retryClose;
		expect(closeAttempts).toBe(2);
		expect(client.close()).toBe(retryClose);
	});
});
