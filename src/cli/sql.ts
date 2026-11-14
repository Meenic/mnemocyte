import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderInitialSchema } from "../db/migrations/runner.js";
import { assertMigrateDimensions } from "../memory/validation.js";
import type { CliArgs } from "./args.js";
import { CliError, type CliIo, EXIT_USAGE } from "./io.js";
import { loadMemoryFile, locateMemoryFile } from "./memory-file.js";
import { loadEnvironment } from "./target.js";

/**
 * `mnemocyte sql`: print the schema a fresh install creates, for teams that
 * apply SQL with their own tools. It never queries a database.
 *
 * `--dimensions` alone loads no file. Without it the size is the embedder's
 * in the memory file, which is imported, so whatever that file does at the
 * top level (creating a client, opening a PGlite folder) happens.
 *
 * @returns The exit code.
 * @throws {CliError} With exit code 2 when no dimensions can be found.
 */
export async function sqlCommand(args: CliArgs, io: CliIo): Promise<number> {
	let dimensions = args.dimensions;
	if (dimensions === undefined) {
		loadEnvironment(io.cwd, args.envFile);
		const file = locateMemoryFile(io.cwd, args.config);
		if (file === null) {
			throw new CliError(
				"sql needs the embedding size: pass --dimensions <n>, or run it where a memory file is.",
				EXIT_USAGE,
			);
		}
		const { embedder } = await loadMemoryFile(file, io.cwd);
		assertMigrateDimensions(embedder.dimensions, "embedder.dimensions");
		dimensions = embedder.dimensions;
	}

	const schema = renderInitialSchema(dimensions);
	if (args.out === undefined) {
		io.write(schema);
	} else {
		await writeFile(resolve(io.cwd, args.out), schema);
		io.error(`Wrote ${args.out} (${dimensions} dimensions)\n`);
	}
	return 0;
}
