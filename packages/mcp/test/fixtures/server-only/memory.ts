// A Next.js-style memory file that guards itself with React's server-only
// marker. The bin maps it to an empty module, installed or not, for import
// and require alike.
import "server-only";
import { createMemory } from "mnemocyte";
import { embedder } from "../app/src/embedder";
import legacy from "./legacy.cjs";

export const memory = createMemory({ namespace: legacy.label, embedder });
