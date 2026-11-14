import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMnemocyteError, MnemocyteError } from "mnemocyte";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const dist = fileURLToPath(new URL("../../dist", import.meta.url));

// A second copy of the built package, as when an app and a library each
// install their own Mnemocyte: separate module instances, separate classes.
type RootModule = typeof import("mnemocyte");
let copyDir: string;
let copy: RootModule;

beforeAll(async () => {
	copyDir = await mkdtemp(join(tmpdir(), "mnemocyte-copy-"));
	await cp(dist, join(copyDir, "dist"), { recursive: true });
	await writeFile(
		join(copyDir, "package.json"),
		JSON.stringify({ name: "mnemocyte-copy", type: "module" }),
	);
	copy = (await import(
		pathToFileURL(join(copyDir, "dist", "index.mjs")).href
	)) as RootModule;
});

afterAll(async () => {
	await rm(copyDir, { recursive: true, force: true });
});

describe("two copies of the package", () => {
	test("load different classes", () => {
		expect(copy.MnemocyteError).not.toBe(MnemocyteError);
	});

	test("recognize each other's errors with isMnemocyteError", () => {
		const fromCopy = new copy.MnemocyteError({
			message: "Key in use.",
			code: "CONFLICT",
			reason: "KEY_IN_USE",
		});
		const fromPackage = new MnemocyteError({
			message: "Slow.",
			code: "TIMEOUT",
		});
		expect(fromCopy instanceof MnemocyteError).toBe(false);
		expect(isMnemocyteError(fromCopy)).toBe(true);
		expect(copy.isMnemocyteError(fromPackage)).toBe(true);
		expect(
			isMnemocyteError(new copy.ProviderError({ message: "x", status: 500 })),
		).toBe(true);
		expect(fromCopy.reason).toBe("KEY_IN_USE");
	});
});
