import assert from "node:assert/strict";
import { createMnemocyte, isMnemocyteError } from "../../dist/index.mjs";

const events = [];
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
	await client.recall({ entityId, query: "successful operations", limit: 1 });
	await client.buildContext({
		entityId,
		query: "successful operations",
		limit: 1,
	});

	await assert.rejects(
		() => client.forget({ entityId, memoryId: "missing" }),
		(error) => {
			assert.equal(isMnemocyteError(error), true);
			assert.equal(error.code, "NOT_FOUND");
			return true;
		},
	);

	await client.forget({ entityId, memoryId: memory.id });
} finally {
	await client.close();
}

const rememberEvents = events.filter((event) => event.operation === "remember");
assert.equal(rememberEvents[0]?.phase, "start");
assert.equal(rememberEvents[1]?.phase, "success");
assert.equal(rememberEvents[0]?.backend, "in-memory");
assert.equal(rememberEvents[0]?.entityId, entityId);
assert.equal(rememberEvents[1]?.count, 1);
assert.equal(rememberEvents[1]?.memoryId !== undefined, true);
assert.equal(typeof rememberEvents[1]?.durationMs, "number");

const recallSuccess = events.find(
	(event) => event.operation === "recall" && event.phase === "success",
);
assert.equal(recallSuccess?.count, 1);

const errorEvent = events.find(
	(event) => event.operation === "forget" && event.phase === "error",
);
assert.equal(errorEvent?.entityId, entityId);
assert.equal(errorEvent?.memoryId, "missing");
assert.equal(isMnemocyteError(errorEvent?.error), true);

const closeSuccess = events.find(
	(event) => event.operation === "close" && event.phase === "success",
);
assert.equal(closeSuccess?.backend, "in-memory");

console.log("Observability hook tests passed.");
