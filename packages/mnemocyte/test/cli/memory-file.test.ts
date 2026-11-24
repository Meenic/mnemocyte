import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { locateMemoryFile } from "../../src/cli/memory-file.js";

// The lookup and the resolve hook are tested in packages/loader; this is
// the CLI's own `--config` handling.

let root: string;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "mnemocyte-cli-unit-"));
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

async function write(
	directory: string,
	files: Record<string, string>,
): Promise<string> {
	const base = join(root, directory);
	for (const [name, content] of Object.entries(files)) {
		const path = join(base, name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
	}
	return base;
}

describe("locateMemoryFile", () => {
	test("--config names any file, and must exist", async () => {
		const base = await write("config", {
			"app/clients/mem.ts": "",
			"memory.ts": "",
		});
		expect(locateMemoryFile(base, "app/clients/mem.ts")).toBe(
			join(base, "app", "clients", "mem.ts"),
		);
		expect(locateMemoryFile(base, undefined)).toBe(join(base, "memory.ts"));
		expect(() => locateMemoryFile(base, "app/nope.ts")).toThrow(
			"--config: app/nope.ts is not a file.",
		);
		// A folder is not a memory file.
		expect(() => locateMemoryFile(base, "app")).toThrow("is not a file");
	});
});
