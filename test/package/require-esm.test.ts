import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	createPackedConsumer,
	type PackedConsumer,
} from "./packed-consumer.js";

// Mnemocyte is ESM-only. Node loads ES modules through require() (require
// esm) without a flag or a warning from 22.13 on, so on every version
// `engines` allows, CommonJS code can require each entry. It would throw
// ERR_REQUIRE_ASYNC_MODULE if a module in an entry's graph used top-level
// await. The script compares each require() with import() of the same entry.
const REQUIRE_EVERY_EXPORT = `
const { exports: entries } = require("mnemocyte/package.json");

async function main() {
	const results = {};
	for (const key of Object.keys(entries)) {
		const specifier = "mnemocyte" + key.slice(1);
		try {
			const required = require(specifier);
			const imported = specifier.endsWith(".json")
				? (await import(specifier, { with: { type: "json" } })).default
				: await import(specifier);
			results[specifier] = {
				ok: true,
				required: Object.keys(required).sort(),
				imported: Object.keys(imported).sort(),
			};
		} catch (error) {
			results[specifier] = {
				ok: false,
				code: error.code,
				message: String(error.message).split("\\n")[0],
			};
		}
	}
	process.stdout.write(JSON.stringify(results));
}

main().catch((error) => {
	process.stderr.write(String(error && error.stack));
	process.exitCode = 1;
});
`;

type RequireResult =
	| { ok: true; required: string[]; imported: string[] }
	| { ok: false; code: string; message: string };

let packed: PackedConsumer;
let script: string;
let specifiers: string[];

async function requireEveryExport(): Promise<Record<string, RequireResult>> {
	const { stdout, stderr } = await packed.run(script);
	// No ExperimentalWarning or any other output on stderr.
	expect(stderr).toBe("");
	return JSON.parse(stdout) as Record<string, RequireResult>;
}

beforeAll(async () => {
	packed = await createPackedConsumer();
	script = join(packed.dir, "require-every-export.cjs");
	await writeFile(script, REQUIRE_EVERY_EXPORT, "utf8");
	const manifest = JSON.parse(
		await readFile(join(packed.packageDir, "package.json"), "utf8"),
	) as { exports: Record<string, unknown> };
	specifiers = Object.keys(manifest.exports).map(
		(key) => `mnemocyte${key.slice(1)}`,
	);
});

afterAll(async () => {
	await packed.remove();
});

describe("require() from CommonJS", () => {
	test("loads every export of the packed package with the optional peers absent", async () => {
		const results = await requireEveryExport();
		expect(Object.keys(results).sort()).toEqual([...specifiers].sort());

		for (const specifier of specifiers) {
			const result = results[specifier];
			if (specifier === "mnemocyte/ai-sdk") {
				// Its ai peer is not installed: the same failure import() gives.
				expect(result).toMatchObject({
					ok: false,
					code: "ERR_MODULE_NOT_FOUND",
				});
				expect(result?.ok === false && result.message).toContain("'ai'");
				continue;
			}
			if (specifier === "mnemocyte/store/test") {
				// Its vitest peer is not installed.
				expect(result).toMatchObject({
					ok: false,
					code: "ERR_MODULE_NOT_FOUND",
				});
				expect(result?.ok === false && result.message).toContain("'vitest'");
				continue;
			}
			expect(result, specifier).toMatchObject({ ok: true });
			if (result?.ok) {
				expect(result.required.length, specifier).toBeGreaterThan(0);
				expect(result.required, specifier).toEqual(result.imported);
			}
		}
	}, 30_000);

	test("loads mnemocyte/ai-sdk once ai is installed", async () => {
		await packed.linkAi();
		const results = await requireEveryExport();
		for (const specifier of specifiers) {
			const result = results[specifier];
			if (specifier === "mnemocyte/store/test") {
				continue;
			}
			expect(result, specifier).toMatchObject({ ok: true });
			if (result?.ok) {
				expect(result.required, specifier).toEqual(result.imported);
			}
		}
		expect(results["mnemocyte/ai-sdk"]).toMatchObject({
			ok: true,
			required: expect.arrayContaining(["memoryTools", "withMemory"]),
		});
	}, 30_000);

	test("loads mnemocyte/store/test once vitest is installed", async () => {
		await packed.linkVitest();
		const results = await requireEveryExport();
		// require(esm) loads the entry as ESM, so its import of vitest
		// resolves to vitest's ESM entry, not the CommonJS one that throws.
		expect(results["mnemocyte/store/test"]).toEqual({
			ok: true,
			required: [
				"STORE_CONTRACT_DIMENSIONS",
				"STORE_CONTRACT_EMBEDDING_MODEL",
				"describeMemoryStoreContract",
			],
			imported: [
				"STORE_CONTRACT_DIMENSIONS",
				"STORE_CONTRACT_EMBEDDING_MODEL",
				"describeMemoryStoreContract",
			],
		});
	}, 30_000);
});
