// Takes its namespace from the environment, so a test can see which env
// file the bin read. The test passes it with --config from another folder.
import { createMemory } from "mnemocyte";
import { embedder } from "../app/src/embedder.ts";

export const memory = createMemory({
	namespace: process.env.MCP_TEST_NAMESPACE ?? "unset",
	embedder,
});
