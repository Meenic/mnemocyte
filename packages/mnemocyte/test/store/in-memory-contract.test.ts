import { defineMemoryStore } from "mnemocyte/store";
import { describeMemoryStoreContract } from "mnemocyte/store/test";
import { inMemoryStoreV1 } from "./in-memory-v1.js";

// The shipped suite, run through `defineMemoryStore` and the V1 adapter.
// The in-memory store cannot fail its audit writes, so that test skips.
const store = defineMemoryStore({ store: inMemoryStoreV1() });
describeMemoryStoreContract({ name: "in-memory", store: () => store });

const bare = defineMemoryStore({
	store: inMemoryStoreV1({ withOptionalMethods: false }),
});
describeMemoryStoreContract({
	name: "in-memory without optional methods",
	store: () => bare,
});
