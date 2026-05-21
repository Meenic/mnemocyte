import {
	createMnemocyte,
	isMnemocyteError,
	type MnemocyteObservation,
} from "mnemocyte";
import { describe, expect, test } from "vitest";
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

		// 3. createMnemocyte rejects a Postgres config with non-1536 embedder dims.
		{
			let thrown: unknown;
			try {
				createMnemocyte({
					databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/none",
					embedder: {
						model: "wrong-dims",
						dimensions: 768,
						async embed(texts) {
							return texts.map(() => [0]);
						},
					},
				});
			} catch (error) {
				thrown = error;
			}
			expect(thrown, "expected createMnemocyte to throw").toBeTruthy();
			expect(isMnemocyteError(thrown)).toBe(true);
			if (!isMnemocyteError(thrown)) {
				throw thrown;
			}
			expect(thrown.code).toBe("CONFIG");
			expect(thrown.message).toMatch(/1536/);
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
});
