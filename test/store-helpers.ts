import type {
	StoreEntitySelector,
	StoreScope,
	StoreVisibility,
} from "../src/memory/store.js";
import { TEST_NAMESPACE } from "./helpers.js";

/** The exact store scope of `testScope(entityId)`: no agent, no session. */
export function testStoreScope(entityId: string): StoreScope {
	return {
		namespace: TEST_NAMESPACE,
		entityId,
		agentId: null,
		sessionId: null,
	};
}

/** What a read at `testScope(entityId)` sees. */
export function testVisibility(entityId: string): StoreVisibility {
	return {
		scope: testStoreScope(entityId),
		exactAgent: false,
		exactSession: false,
	};
}

/** Every row of the entity, across agents and sessions. */
export function testSelector(entityId: string): StoreEntitySelector {
	return { namespace: TEST_NAMESPACE, entityId };
}
