import type { MemoryStoreV1 } from "mnemocyte/store";
import { createInMemoryStore } from "../../src/memory/in-memory.js";

/**
 * The in-memory store as a third-party backend would hand it over: the
 * `MemoryStoreV1` members only, without the first-party extras.
 */
export function inMemoryStoreV1(
	options: { withOptionalMethods?: boolean } = {},
): MemoryStoreV1 {
	const {
		backend: _backend,
		inspectInstallation: _inspect,
		setTextSearchConfig: _textSearch,
		migrate,
		ensureEmbeddingCompatibility,
		...rest
	} = createInMemoryStore();
	return {
		specificationVersion: "v1",
		name: "in-memory-v1",
		...rest,
		...(options.withOptionalMethods === false
			? {}
			: { migrate, ensureEmbeddingCompatibility }),
	};
}
