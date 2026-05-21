import {
	createMnemocyte,
	isMnemocyteError,
	type MnemocyteObservation,
} from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

describe("observability hooks", () => {
	test("emits lifecycle events for operations", async () => {
		const events: MnemocyteObservation[] = [];
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
			await client.recall({
				entityId,
				query: "successful operations",
				limit: 1,
			});
			await client.buildContext({
				entityId,
				query: "successful operations",
				limit: 1,
			});

			await expectMnemocyteError(
				client.forget({ entityId, memoryId: "missing" }),
				"NOT_FOUND",
			);

			await client.forget({ entityId, memoryId: memory.id });
		} finally {
			await client.close();
		}

		const rememberEvents = events.filter(
			(event) => event.operation === "remember",
		);
		expect(rememberEvents[0]?.phase).toBe("start");
		expect(rememberEvents[1]?.phase).toBe("success");
		expect(rememberEvents[0]?.backend).toBe("in-memory");
		expect(rememberEvents[0]?.entityId).toBe(entityId);
		expect(rememberEvents[1]?.count).toBe(1);
		expect(rememberEvents[1]?.memoryId !== undefined).toBe(true);
		expect(typeof rememberEvents[1]?.durationMs).toBe("number");

		const recallSuccess = events.find(
			(event) => event.operation === "recall" && event.phase === "success",
		);
		expect(recallSuccess?.count).toBe(1);

		const errorEvent = events.find(
			(event) => event.operation === "forget" && event.phase === "error",
		);
		expect(errorEvent?.entityId).toBe(entityId);
		expect(errorEvent?.memoryId).toBe("missing");
		expect(isMnemocyteError(errorEvent?.error)).toBe(true);

		const closeSuccess = events.find(
			(event) => event.operation === "close" && event.phase === "success",
		);
		expect(closeSuccess?.backend).toBe("in-memory");
	});
});
