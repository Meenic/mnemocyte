import type { MemoryScope } from "mnemocyte";

/** The namespace every test scope uses unless a test chooses another. */
export const TEST_NAMESPACE = "test";

/** A scope in {@link TEST_NAMESPACE} for `entityId`. */
export function testScope(
	entityId: string,
	extra: Omit<Partial<MemoryScope>, "entityId"> = {},
): MemoryScope {
	return { namespace: TEST_NAMESPACE, entityId, ...extra };
}
