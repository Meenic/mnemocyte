// Temporary repositories with the published packages' layout, for the
// release scripts to read and write.
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

export const ROOT_CHANGELOG: string = readFileSync(
	new URL("./fixtures/root-changelog.md", import.meta.url),
	"utf8",
).replace(/\r\n/g, "\n");

/** The 1-based line of the first fixture line that contains `text`. */
export function lineOf(text: string): number {
	return ROOT_CHANGELOG.split("\n").findIndex((l) => l.includes(text)) + 1;
}

export const MCP_CHANGELOG: string = readFileSync(
	new URL("./fixtures/mcp-changelog.md", import.meta.url),
	"utf8",
).replace(/\r\n/g, "\n");

export interface RepoInput {
	readonly rootChangelog?: string;
	readonly mcpChangelog?: string;
	readonly mnemocyteVersion?: string;
	readonly mcpVersion?: string;
}

const created: string[] = [];

afterEach(() => {
	for (const dir of created.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A folder with both changelogs and both package.json files. */
export function makeRepo(input: RepoInput = {}): string {
	const root = mkdtempSync(join(tmpdir(), "mnemocyte-release-"));
	created.push(root);
	write(root, "CHANGELOG.md", input.rootChangelog ?? ROOT_CHANGELOG);
	write(root, "packages/mcp/CHANGELOG.md", input.mcpChangelog ?? MCP_CHANGELOG);
	write(
		root,
		"packages/mnemocyte/package.json",
		`${JSON.stringify({ name: "mnemocyte", version: input.mnemocyteVersion ?? "1.1.0" }, null, "\t")}\n`,
	);
	write(
		root,
		"packages/mcp/package.json",
		`${JSON.stringify({ name: "@mnemocyte/mcp", version: input.mcpVersion ?? "0.1.0" }, null, "\t")}\n`,
	);
	return root;
}

export function read(root: string, path: string): string {
	return readFileSync(join(root, path), "utf8");
}

export function write(root: string, path: string, text: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
}
