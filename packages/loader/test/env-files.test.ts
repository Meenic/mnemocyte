import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadEnvFiles } from "../src/env-files.js";

// Every variable the files below set, so each test starts without them and
// vi.unstubAllEnvs removes what process.loadEnvFile added.
const VARIABLES = ["LOADER_TEST_A", "LOADER_TEST_B", "LOADER_TEST_C"];

describe("loadEnvFiles", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "mnemocyte-loader-env-"));
		// Vitest sets NODE_ENV to test; the bins run without it.
		vi.stubEnv("NODE_ENV", "development");
		for (const name of VARIABLES) {
			vi.stubEnv(name, undefined);
		}
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	async function files(contents: Record<string, string>): Promise<void> {
		for (const [name, content] of Object.entries(contents)) {
			await writeFile(join(directory, name), content, "utf8");
		}
	}

	test("reads .env.local, then .env, and the first value wins", async () => {
		await files({
			".env.local": "LOADER_TEST_A=local\n",
			".env": "LOADER_TEST_A=base\nLOADER_TEST_B=base\n",
		});
		expect(loadEnvFiles({ directory })).toEqual([".env.local", ".env"]);
		expect(process.env.LOADER_TEST_A).toBe("local");
		expect(process.env.LOADER_TEST_B).toBe("base");
	});

	test("a variable that is already set wins over both files", async () => {
		vi.stubEnv("LOADER_TEST_A", "shell");
		await files({
			".env.local": "LOADER_TEST_A=local\n",
			".env": "LOADER_TEST_A=base\n",
		});
		loadEnvFiles({ directory });
		expect(process.env.LOADER_TEST_A).toBe("shell");
	});

	test("reads either file alone, and nothing without them", async () => {
		expect(loadEnvFiles({ directory })).toEqual([]);

		await files({ ".env.local": "LOADER_TEST_C=local\n" });
		expect(loadEnvFiles({ directory })).toEqual([".env.local"]);
		expect(process.env.LOADER_TEST_C).toBe("local");

		await rm(join(directory, ".env.local"));
		await files({ ".env": "LOADER_TEST_B=base\n" });
		expect(loadEnvFiles({ directory })).toEqual([".env"]);
		expect(process.env.LOADER_TEST_B).toBe("base");
	});

	test("skips .env.local when NODE_ENV is test", async () => {
		vi.stubEnv("NODE_ENV", "test");
		await files({
			".env.local": "LOADER_TEST_A=local\n",
			".env": "LOADER_TEST_A=base\n",
		});
		expect(loadEnvFiles({ directory })).toEqual([".env"]);
		expect(process.env.LOADER_TEST_A).toBe("base");
	});

	test("does not expand references, unlike Next.js", async () => {
		await files({
			".env": "LOADER_TEST_A=one\nLOADER_TEST_B=$LOADER_TEST_A\n",
		});
		loadEnvFiles({ directory });
		expect(process.env.LOADER_TEST_B).toBe("$LOADER_TEST_A");
	});

	test("ignores a folder named like an env file", async () => {
		await mkdir(join(directory, ".env.local"));
		expect(loadEnvFiles({ directory })).toEqual([]);
	});
});
