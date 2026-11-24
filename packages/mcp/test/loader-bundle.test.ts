import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The bin bundles @mnemocyte/loader (packages/loader), which the
// `mnemocyte` CLI bundles too. Its source map embeds the sources it was
// built from, so matching them against packages/loader/src shows that this
// dist/ holds the current loader.
// packages/mnemocyte/test/package/loader-bundle.test.ts checks the same for
// that bin, so both ship the same code. Run after `pnpm build`.

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const loaderSource = fileURLToPath(
	new URL("../../loader/src", import.meta.url),
);

function normalize(text: string): string {
	return text.replaceAll("\r\n", "\n");
}

/** Every file reached from `entry` through relative static imports. */
async function staticImportGraph(entry: string): Promise<Set<string>> {
	const reached = new Set<string>();
	const pending = [entry];
	for (let file = pending.pop(); file; file = pending.pop()) {
		if (reached.has(file)) {
			continue;
		}
		reached.add(file);
		const source = await readFile(file, "utf8");
		for (const match of source.matchAll(
			/^import\s+(?:[^"']+\s+from\s+)?["'](\.{1,2}\/[^"']+)["'];?\s*$/gm,
		)) {
			pending.push(resolve(dirname(file), match[1] ?? ""));
		}
	}
	return reached;
}

describe("the bundled loader", () => {
	it("dist/cli.mjs is built from the current packages/loader/src", async () => {
		const mapFile = resolve(dist, "cli.mjs.map");
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

	it("stays out of the static import graph of dist/index.mjs", async () => {
		// createMemoryMcpServer is a library entry: an app that imports it
		// must never get a module hook.
		for (const file of await staticImportGraph(resolve(dist, "index.mjs"))) {
			const source = await readFile(file, "utf8");
			expect(source, file).not.toMatch(
				/\bregisterHooks\b|\bregisterAppResolver\b/,
			);
		}
	});
});
