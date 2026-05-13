import assert from "node:assert/strict";
import { createMnemocyte, isMnemocyteError } from "../../dist/index.mjs";

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

async function expectClosed(label, action) {
	await assert.rejects(
		action,
		(error) => {
			assert.equal(
				isMnemocyteError(error),
				true,
				`${label} should throw MnemocyteError`,
			);
			assert.equal(
				error.code,
				"DB",
				`${label} should throw code "DB" after close`,
			);
			return true;
		},
		`${label} should reject after close()`,
	);
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

	await expectClosed("remember", () =>
		client.remember({ entityId: "alice", content: "later" }),
	);
	await expectClosed("rememberMany", () =>
		client.rememberMany([{ entityId: "alice", content: "later" }]),
	);
	await expectClosed("recall", () =>
		client.recall({ entityId: "alice", query: "hi" }),
	);
	await expectClosed("buildContext", () =>
		client.buildContext({ entityId: "alice", query: "hi" }),
	);
	await expectClosed("forget", () =>
		client.forget({ entityId: "alice", memoryId: "mem_nope" }),
	);
	await expectClosed("forgetAll", () =>
		client.forgetAll({ entityId: "alice" }),
	);
	await expectClosed("prune", () => client.prune({ entityId: "alice" }));
	await expectClosed("stats", () => client.stats());
}

// 3. Observability still fires for close() and is then quiet for the rejected calls.
{
	const events = [];
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
	assert.equal(closeSuccess?.backend, "in-memory");
	await assert.rejects(() =>
		client.remember({ entityId: "alice", content: "x" }),
	);
	const errorEvent = events.find(
		(event) => event.operation === "remember" && event.phase === "error",
	);
	assert.equal(errorEvent?.backend, "in-memory");
}

console.log("Lifecycle close tests passed.");
