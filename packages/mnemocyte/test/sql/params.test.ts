import { describe, expect, test } from "vitest";
import { createSqlParams } from "../../src/db/sql.js";

describe("SQL parameter collector", () => {
	test("numbers placeholders in the order values are added", () => {
		const params = createSqlParams();

		expect(params.add("a")).toBe("$1");
		expect(params.list(["b", "c"])).toBe("$2, $3");
		expect(params.values).toEqual(["a", "b", "c"]);
	});

	test("sends timestamps as ISO strings, never Date objects", () => {
		const params = createSqlParams();
		const date = new Date("2026-01-02T03:04:05.000Z");

		expect(params.timestamp(date)).toBe("$1::timestamptz");
		expect(params.values).toEqual(["2026-01-02T03:04:05.000Z"]);
	});

	test("sends JSON as text so no driver serializer wraps it again", () => {
		const params = createSqlParams();

		expect(params.json({ a: 1 })).toBe("$1::text::jsonb");
		expect(params.values).toEqual(['{"a":1}']);
	});

	test("builds one parameter for a tag array that keeps its order", () => {
		const params = createSqlParams();

		const expression = params.textArrayValue(["b", "a"]);

		expect(params.values).toEqual(['["b","a"]']);
		expect(expression).toContain("$1::text::jsonb");
		expect(expression).toContain("ORDER BY position");
	});

	test("builds containment arrays with one parameter per tag", () => {
		const params = createSqlParams();

		expect(params.textArray(["x", "y"])).toBe("ARRAY[$1, $2]::text[]");
		expect(params.values).toEqual(["x", "y"]);
	});
});
