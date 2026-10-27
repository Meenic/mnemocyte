/**
 * Collects positional parameters while a statement is assembled, so a
 * placeholder is always numbered in the order it is added.
 */
export interface SqlParams {
	readonly values: unknown[];
	/** Add one value and return its `$n` placeholder. */
	add(value: unknown): string;
	/** `$1, $2, …` for an `IN (…)` list. */
	list(values: readonly unknown[]): string;
	/** A `timestamptz` placeholder. Sent as an ISO string, never a `Date`. */
	timestamp(value: Date): string;
	/** A `uuid` placeholder, cast so drivers that type strings as `text` work. */
	uuid(value: string): string;
	/** `$1::uuid, $2::uuid, …` for an `IN (…)` list of ids. */
	uuidList(values: readonly string[]): string;
	/** A JSON array parameter, read as rows of `(element, position)`. */
	jsonArrayRows(values: readonly string[]): string;
	/** `ARRAY[$1, $2]::text[]`, for containment checks. */
	textArray(values: readonly string[]): string;
	/** A `text[]` value built from one JSON parameter, in input order. */
	textArrayValue(values: readonly string[]): string;
	/** A `jsonb` placeholder, sent as text so no driver serializer touches it. */
	json(value: unknown): string;
}

export function createSqlParams(): SqlParams {
	const values: unknown[] = [];
	const params: SqlParams = {
		values,
		add(value) {
			values.push(value);
			return `$${values.length}`;
		},
		list(items) {
			return items.map((item) => params.add(item)).join(", ");
		},
		timestamp(value) {
			return `${params.add(value.toISOString())}::timestamptz`;
		},
		uuid(value) {
			return `${params.add(value)}::uuid`;
		},
		uuidList(items) {
			return items.map((item) => params.uuid(item)).join(", ");
		},
		jsonArrayRows(items) {
			const placeholder = params.add(JSON.stringify(items));
			return `jsonb_array_elements_text(${placeholder}::text::jsonb) WITH ORDINALITY AS e(element, position)`;
		},
		textArray(items) {
			return `ARRAY[${params.list(items)}]::text[]`;
		},
		textArrayValue(items) {
			const placeholder = params.add(JSON.stringify(items));
			return `ARRAY(SELECT element FROM jsonb_array_elements_text(${placeholder}::text::jsonb) WITH ORDINALITY AS e(element, position) ORDER BY position)`;
		},
		json(value) {
			return `${params.add(JSON.stringify(value))}::text::jsonb`;
		},
	};
	return params;
}
