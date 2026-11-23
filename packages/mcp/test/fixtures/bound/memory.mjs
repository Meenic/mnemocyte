import { createMemory } from "mnemocyte";
import { embedder } from "../app/src/embedder.ts";

export const memory = createMemory({ namespace: "app", embedder }).for({
	entityId: "someone",
});
