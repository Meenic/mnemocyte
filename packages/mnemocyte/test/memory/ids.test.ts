import { describe, expect, test } from "vitest";
import { createUuidV7, isUuid } from "../../src/memory/records.js";

const UUID_V7 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("UUIDv7 ids", () => {
	test("sets the version and variant bits", () => {
		for (let index = 0; index < 100; index += 1) {
			expect(createUuidV7()).toMatch(UUID_V7);
		}
	});

	test("starts with the Unix milliseconds", () => {
		const now = Date.UTC(2026, 9, 27, 12, 0, 0, 123);

		const id = createUuidV7(now);

		expect(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toBe(now);
	});

	test("sorts by creation time across milliseconds", () => {
		const earlier = createUuidV7(1_000);
		const later = createUuidV7(1_001);

		expect(earlier < later).toBe(true);
	});

	test("recognizes canonical UUIDs only", () => {
		expect(isUuid(createUuidV7())).toBe(true);
		expect(isUuid("0192F1C2-7A3B-7C4D-8E5F-60718293A4B5")).toBe(true);
		expect(isUuid("mem_abc_123")).toBe(false);
		expect(isUuid("")).toBe(false);
	});
});
