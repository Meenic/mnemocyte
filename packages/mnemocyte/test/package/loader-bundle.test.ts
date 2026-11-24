import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// The bin bundles @mnemocyte/loader (packages/loader), which
// @mnemocyte/mcp bundles too. Its source map embeds the sources it was
// built from, so matching them against packages/loader/src shows that this
// dist/ holds the current loader. packages/mcp/test/loader-bundle.test.ts
// checks the same for that bin, so both ship the same code.

const loaderSource = resolve("../loader/src");

function normalize(text: string): string {
	return text.replaceAll("\r\n", "\n");
}

describe("the bundled loader", () => {
	test("dist/cli.mjs is built from the current packages/loader/src", async () => {
		const mapFile = resolve("dist/cli.mjs.map");
		const map = JSON.parse(await readFile(mapFile, "utf8")) as {
			sources: string[];
			sourcesContent: (string | null)[];
		};
		const bundled = new Map<string, string | null>();
		map.sources.forEach((source, index) => {
			const file = resolve(dirname(mapFile), source);
			if (dirname(file) === loaderSource) {
				bundled.set(file, map.sourcesContent[index] ?? null);
			}
		});
		// index.ts only re-exports, so the bundle has no code from it.
		const files = (await readdir(loaderSource))
			.filter((name) => name.endsWith(".ts") && name !== "index.ts")
			.map((name) => resolve(loaderSource, name))
			.sort();
		expect([...bundled.keys()].sort()).toEqual(files);
		for (const file of files) {
			const content = bundled.get(file);
			expect(content === null || content === undefined, file).toBe(false);
			expect(normalize(content ?? ""), file).toBe(
				normalize(await readFile(file, "utf8")),
			);
		}
	});
});
