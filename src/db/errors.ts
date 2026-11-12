/**
 * The constraint a driver error names, or `undefined`. postgres.js calls the
 * field `constraint_name`; node-postgres and PGlite (both built on
 * `pg-protocol`) call it `constraint`.
 */
export function postgresConstraintName(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) {
		return undefined;
	}
	const fields = error as { constraint_name?: unknown; constraint?: unknown };
	const name = fields.constraint_name ?? fields.constraint;
	return typeof name === "string" ? name : undefined;
}
