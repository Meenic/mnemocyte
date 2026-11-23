import { Console } from "node:console";

// The console methods that write to standard output.
const STDOUT_METHODS = [
	"log",
	"info",
	"debug",
	"dir",
	"dirxml",
	"table",
	"group",
	"groupCollapsed",
	"groupEnd",
	"count",
	"countReset",
	"time",
	"timeEnd",
	"timeLog",
] as const;

/**
 * Send everything `console` would print to standard output to standard
 * error instead. On stdio, standard output carries only MCP messages, so a
 * `console.log` in the app's memory file or a module it imports would
 * corrupt the stream. Writes to `process.stdout` itself are not caught.
 */
export function redirectConsoleToStderr(): void {
	const toStderr = new Console({
		stdout: process.stderr,
		stderr: process.stderr,
	});
	for (const method of STDOUT_METHODS) {
		// Console binds its methods to the instance, so they can move.
		Object.defineProperty(console, method, {
			value: toStderr[method],
			writable: true,
			configurable: true,
			enumerable: true,
		});
	}
}
