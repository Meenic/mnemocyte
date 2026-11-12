import { createMemory } from "mnemocyte";
import { describe, test } from "vitest";
import {
	createGatedEmbedder,
	verifyRememberInputSnapshots,
} from "../fixtures/remember-input-snapshot.js";

describe("remember input snapshots", () => {
	test("owns mutable single and batch inputs before awaiting", async () => {
		const gate = createGatedEmbedder("remember-input-snapshot", 2);
		const client = createMemory({ embedder: gate.embedder });

		await verifyRememberInputSnapshots(
			client,
			gate.nextCall,
			"snapshot_in_memory",
		);
	});
});
