import { MnemocyteError } from "../errors.js";

/** Iterative HNSW scans (`hnsw.iterative_scan`) arrived in pgvector 0.8.0. */
const MIN_PGVECTOR_VERSION: readonly [number, number] = [0, 8];

/**
 * Throw `"MIGRATION"` unless `version` (`pg_extension.extversion`, or null
 * when the extension is not installed) is pgvector 0.8.0 or later.
 */
export function assertPgvectorVersion(version: string | null): void {
	if (version === null) {
		throw new MnemocyteError(
			"pgvector is not installed in this database. Run CREATE EXTENSION vector as a role that may create extensions.",
			"MIGRATION",
		);
	}
	const [major = Number.NaN, minor = Number.NaN] = version
		.split(".")
		.map((part) => Number.parseInt(part, 10));
	const [minMajor, minMinor] = MIN_PGVECTOR_VERSION;
	if (
		!Number.isInteger(major) ||
		!Number.isInteger(minor) ||
		major < minMajor ||
		(major === minMajor && minor < minMinor)
	) {
		throw new MnemocyteError(
			`Mnemocyte needs pgvector ${minMajor}.${minMinor}.0 or later for filtered vector search; this database has ${version}. Upgrade the pgvector package on the server, then run ALTER EXTENSION vector UPDATE.`,
			"MIGRATION",
		);
	}
}
