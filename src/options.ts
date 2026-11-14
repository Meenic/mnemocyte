import { MnemocyteError } from "./errors.js";

/**
 * Throw `"CONFIG"` when `value` has a key that is not in `accepted`.
 *
 * TypeScript flags a misspelled key only in an object literal; from
 * JavaScript, or with options built elsewhere, an ignored `baseURL` would
 * send content to a provider's default endpoint. A key whose value is
 * `undefined` still counts as given, so it must be a known one. A value
 * that is not an object is left to the caller's own type check.
 *
 * `name` prefixes the message (`openaiEmbedder`, `createMemory retrieval`).
 * `renamed` maps a key an earlier version took to its current name, so the
 * error says what to use instead.
 */
export function assertKnownKeys(
	name: string,
	value: object,
	accepted: readonly string[],
	renamed: Readonly<Record<string, string>> = {},
): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return;
	}
	for (const key of Object.keys(value)) {
		if (accepted.includes(key)) {
			continue;
		}
		const replacement = Object.hasOwn(renamed, key) ? renamed[key] : undefined;
		throw new MnemocyteError(
			replacement === undefined
				? `${name} does not accept the option "${key}". Accepted options: ${accepted.join(", ")}.`
				: `${name} does not accept the option "${key}": it was renamed "${replacement}".`,
			"CONFIG",
		);
	}
}

/** Keys the embedders took as `baseUrl` before 1.0. */
export const RENAMED_BASE_URL: Readonly<Record<string, string>> = {
	baseUrl: "baseURL",
};
