import { describe, expect, test, vi } from "vitest";
import { POSTGRES_CAPABILITIES } from "../../src/memory/capabilities.js";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import {
	createLazyStore,
	type LazyStoreInput,
} from "../../src/memory/lazy-store.js";
import { expectMnemocyteError } from "../helpers.js";

const selector = { namespace: "lazy", entityId: "lazy" };

/** A lazy Postgres store over `load`. */
function lazyStore(load: LazyStoreInput["load"]) {
	return createLazyStore({
		backend: "postgres",
		capabilities: POSTGRES_CAPABILITIES,
		load,
	});
}

describe("lazy store", () => {
	test("knows its backend and capabilities without loading", () => {
		const load = vi.fn(async () => createInMemoryStore());
		const store = lazyStore(load);
		expect(store.backend).toBe("postgres");
		expect(store.capabilities).toBe(POSTGRES_CAPABILITIES);
		expect(load).not.toHaveBeenCalled();
	});

	test("loads once for concurrent first calls and delegates every call", async () => {
		const inner = createInMemoryStore();
		const stats = vi.spyOn(inner, "stats");
		const load = vi.fn(async () => inner);
		const store = lazyStore(load);
		const now = new Date();

		await Promise.all([
			store.stats({ selector, now }),
			store.stats({ selector, now }),
			store.delete({ target: "scope", selector }),
		]);
		const signal = new AbortController().signal;
		await store.stats({ selector, now, signal });

		expect(load).toHaveBeenCalledTimes(1);
		expect(stats).toHaveBeenCalledTimes(3);
		expect(stats).toHaveBeenCalledWith({ selector, now });
		expect(stats).toHaveBeenLastCalledWith({ selector, now, signal });
	});

	test("reports a failed load as CONFIG with the cause and retries on the next call", async () => {
		const cause = new Error("chunk missing");
		const load = vi
			.fn<() => Promise<ReturnType<typeof createInMemoryStore>>>()
			.mockRejectedValueOnce(cause)
			.mockResolvedValue(createInMemoryStore());
		const store = lazyStore(load);

		const error = await expectMnemocyteError(
			store.stats({ selector, now: new Date() }),
			"CONFIG",
		);
		expect(error.message).toMatch(/postgres backend/);
		expect(error.cause).toBe(cause);

		await expect(
			store.stats({ selector, now: new Date() }),
		).resolves.toMatchObject({
			memoryCount: 0,
		});
		expect(load).toHaveBeenCalledTimes(2);
	});

	test("passes store errors through unchanged", async () => {
		const inner = createInMemoryStore();
		const failure = new Error("query failed");
		vi.spyOn(inner, "delete").mockRejectedValue(failure);
		const store = lazyStore(async () => inner);
		await expect(store.delete({ target: "scope", selector })).rejects.toBe(
			failure,
		);
	});
});
