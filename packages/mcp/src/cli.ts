#!/usr/bin/env node
// The `mnemocyte-mcp` bin. Not an export of the package: `package.json`
// lists it under `bin` only.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { redirectConsoleToStderr } from "./cli/console.js";
import { type CliIo, prepare } from "./cli/main.js";
import { SERVER_INFO } from "./server.js";

const io: CliIo = {
	cwd: process.cwd(),
	write: (text) => process.stdout.write(text),
	error: (text) => process.stderr.write(text),
};

// Each stream's empty write is queued behind the output, so its callback
// runs once that is flushed (pipes are asynchronous on Windows).
function exit(code: number): void {
	process.stdout.write("", () => {
		process.stderr.write("", () => process.exit(code));
	});
}

// Before the memory file is imported, so nothing it logs reaches stdout.
redirectConsoleToStderr();

// No top-level await, like the rest of dist/.
void prepare(process.argv.slice(2), io, SERVER_INFO.version).then(
	(prepared) => {
		if (prepared.kind === "exit") {
			exit(prepared.code);
			return;
		}
		serveStdio(prepared.createServer, {
			onerror: (error) => io.error(`mnemocyte-mcp: ${error.message}\n`),
		});
		// The client ends the session by closing stdin. The app's database
		// client, which the bin does not own and cannot close, would keep the
		// process alive, so it exits here.
		let ended = false;
		const end = () => {
			if (!ended) {
				ended = true;
				exit(0);
			}
		};
		process.stdin.once("end", end);
		process.stdin.once("close", end);
	},
);
