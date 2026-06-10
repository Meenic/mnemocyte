import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

describe("initial migration renderer", () => {
	test("renders the selected embedding dimension to stdout", async () => {
		const { stdout } = await execFileAsync("node", [
			"migrations/render-initial.mjs",
			"--dimensions",
			"768",
		]);

		expect(stdout).toContain('"embedding" vector(768)');
		expect(stdout).toContain(
			`INSERT INTO "mnemocyte_meta" ("key", "embedding_dimensions") VALUES ('installation', 768);`,
		);
	});

	test("rejects non-positive dimensions", async () => {
		await expect(
			execFileAsync("node", [
				"migrations/render-initial.mjs",
				"--dimensions",
				"0",
			]),
		).rejects.toThrow();
	});
});
