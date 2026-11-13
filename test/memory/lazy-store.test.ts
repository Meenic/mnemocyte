import { describe, expect, test, vi } from "vitest";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import { createLazyStore } from "../../src/memory/lazy-store.js";
import { expectMnemocyteError } from "../helpers.js";

const selector = { namespace: "lazy", entityId: "lazy" };

describe("lazy store", () => {
	test("knows its backend without loading", () => {
		const load = vi.fn(async () => createInMemoryStore());
		const store = createLazyStore({ backend: "postgres", load });
		expect(store.backend).toBe("postgres");
		expect(load).not.toHaveBeenCalled();
	});

	test("loads once for concurrent first calls and delegates every call", async () => {
		const inner = createInMemoryStore();
		const stats = vi.spyOn(inner, "stats");
		const load = vi.fn(async () => inner);
		const store = createLazyStore({ backend: "postgres", load });
		const now = new Date();

		await Promise.all([
			store.stats(selector, now),
			store.stats(selector, now),
			store.deleteScope(selector),
		]);
		await store.stats(selector, now);

		expect(load).toHaveBeenCalledTimes(1);
		expect(stats).toHaveBeenCalledTimes(3);
		expect(stats).toHaveBeenCalledWith(selector, now);
	});

	test("reports a failed load as CONFIG with the cause and retries on the next call", async () => {
		const cause = new Error("chunk missing");
		const load = vi
			.fn<() => Promise<ReturnType<typeof createInMemoryStore>>>()
			.mockRejectedValueOnce(cause)
			.mockResolvedValue(createInMemoryStore());
		const store = createLazyStore({ backend: "postgres", load });

		const error = await expectMnemocyteError(
			store.stats(selector, new Date()),
			"CONFIG",
		);
		expect(error.message).toMatch(/postgres backend/);
		expect(error.cause).toBe(cause);

		await expect(store.stats(selector, new Date())).resolves.toMatchObject({
			memoryCount: 0,
		});
		expect(load).toHaveBeenCalledTimes(2);
	});

	test("passes store errors through unchanged", async () => {
		const inner = createInMemoryStore();
		const failure = new Error("query failed");
		vi.spyOn(inner, "deleteScope").mockRejectedValue(failure);
		const store = createLazyStore({
			backend: "postgres",
			load: async () => inner,
		});
		await expect(store.deleteScope(selector)).rejects.toBe(failure);
	});
});
