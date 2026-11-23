// An app's memory file, loaded by the bin tests through Node's type
// stripping: the extensionless import needs the resolve hook, and the log
// line must not reach the MCP stream on stdout.
import { createMemory } from "mnemocyte";
import { embedder } from "./embedder";

console.log("memory file loaded");

export const memory = createMemory({ namespace: "app", embedder });
