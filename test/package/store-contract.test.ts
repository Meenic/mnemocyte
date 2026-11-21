import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	createPackedConsumer,
	type PackedConsumer,
} from "./packed-consumer.js";

const execFileAsync = promisify(execFile);

// A backend author's test file: the shipped suite from the packed package,
// on a libSQL file database, with the audit failure hook as a trigger.
const CONTRACT_TEST = `
import { createClient } from "@libsql/client";
import { migrate } from "mnemocyte";
import { libsqlStore } from "mnemocyte/libsql";
import {
	describeMemoryStoreContract,
	STORE_CONTRACT_DIMENSIONS,
} from "mnemocyte/store/test";
import { afterAll, beforeAll } from "vitest";

const client = createClient({ url: "file:contract.db" });
const store = libsqlStore({ client });

beforeAll(async () => {
	await migrate({ store, dimensions: STORE_CONTRACT_DIMENSIONS });
});

afterAll(() => client.close());

describeMemoryStoreContract({
	name: "packed libSQL",
	store: () => store,
	async failAuditWrites({ namespace, failing }) {
		const name = "fail_" + namespace;
		await client.execute(
			failing
				? \`CREATE TRIGGER "\${name}" BEFORE INSERT ON "mnemocyte_events"
					WHEN NEW."namespace" = '\${namespace}'
					BEGIN SELECT RAISE(ABORT, 'audit write refused'); END\`
				: \`DROP TRIGGER IF EXISTS "\${name}"\`,
		);
	},
});
`;

let packed: PackedConsumer;

beforeAll(async () => {
	packed = await createPackedConsumer();
	await packed.linkLibsql();
	await packed.linkVitest();
	await writeFile(join(packed.dir, "contract.test.mjs"), CONTRACT_TEST, "utf8");
});

afterAll(async () => {
	await packed.remove();
});

describe("mnemocyte/store/test from the packed package", () => {
	test("runs the contract suite in the consumer's own Vitest", async () => {
		// The child is a Vitest run of its own; the variables this worker
		// inherited would make it think it runs inside this one.
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) => !key.startsWith("VITEST") && key !== "NODE_OPTIONS",
			),
		);
		const { stdout } = await execFileAsync(
			process.execPath,
			[
				join(packed.nodeModules, "vitest", "vitest.mjs"),
				"run",
				"--root",
				packed.dir,
				"--testTimeout",
				"60000",
			],
			{ cwd: packed.dir, env: { ...env, NODE_PATH: "" }, windowsHide: true },
		);
		expect(stdout).toMatch(/Tests\s+\d+ passed/);
		expect(stdout).not.toMatch(/skipped|failed/);
	}, 180_000);
});
