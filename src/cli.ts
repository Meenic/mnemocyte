#!/usr/bin/env node
// The `mnemocyte` bin. Not an export of the package: `package.json` lists it
// under `bin` only.
import { readFileSync } from "node:fs";
import { createProcessIo } from "./cli/io.js";
import { main } from "./cli/main.js";

function packageVersion(): string {
	// `../package.json` is the package root from both src/ and dist/.
	const manifest: unknown = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);
	return typeof manifest === "object" &&
		manifest !== null &&
		"version" in manifest &&
		typeof manifest.version === "string"
		? manifest.version
		: "unknown";
}

// No top-level await, like the rest of dist/. The process is ended
// explicitly: the app's database client, which the CLI does not own and
// cannot close, would otherwise keep it alive. Each stream's empty write is
// queued behind the output, so its callback runs once that is flushed
// (pipes are asynchronous on Windows).
void main(process.argv.slice(2), createProcessIo(), packageVersion()).then(
	(code) => {
		process.stdout.write("", () => {
			process.stderr.write("", () => process.exit(code));
		});
	},
);
