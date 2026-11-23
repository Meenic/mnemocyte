// Packs the package once and lints the tarball with publint and attw.
// Run through `pnpm lint:package`, which builds first and puts both CLIs on
// PATH.
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "mnemocyte-pack-"));
const tarball = join(directory, "mnemocyte.tgz");

// attw models Node's CommonJS resolution without require(esm), which Node
// supports from 22.12, so it flags every entry as "CJS resolves to ESM". The
// node16 profile skips node10, which cannot see subpath exports.
const commands = [
	`pnpm pack --out "${tarball}"`,
	`publint "${tarball}" --strict`,
	`attw "${tarball}" --profile node16 --ignore-rules cjs-resolves-to-esm`,
];

try {
	for (const command of commands) {
		execSync(command, { stdio: "inherit" });
	}
} catch {
	process.exitCode = 1;
} finally {
	rmSync(directory, { recursive: true, force: true });
}
