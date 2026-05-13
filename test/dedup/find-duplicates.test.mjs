import assert from "node:assert/strict";
import { createMnemocyte, isMnemocyteError } from "../../dist/index.mjs";

/**
 * Deterministic embedder that maps a small dictionary of phrases to fixed
 * 4-dimensional vectors. Unknown content falls back to a content-length
 * based vector so cosine similarity stays bounded but distinct.
 */
function dictionaryEmbedder() {
	const dictionary = new Map([
		["coffee morning", [1, 0, 0, 0]],
		["coffee early", [0.99, 0.05, 0, 0]],
		["tea afternoon", [0, 1, 0, 0]],
		["weather sunny", [0, 0, 1, 0]],
	]);
	return {
		model: "dedup-test",
		dimensions: 4,
		async embed(texts) {
			return texts.map((text) => {
				const vec = dictionary.get(text);
				if (vec) {
					return vec;
				}
				return [text.length, 1, 0, 0];
			});
		},
	};
}

function createClient(extra = {}) {
	return createMnemocyte({ embedder: dictionaryEmbedder(), ...extra });
}

// 1. Empty entityId is rejected with VALIDATION.
{
	const client = createClient();
	try {
		await assert.rejects(
			() => client.findDuplicates({ entityId: "" }),
			(error) => {
				assert.equal(isMnemocyteError(error), true);
				assert.equal(error.code, "VALIDATION");
				return true;
			},
		);
	} finally {
		await client.close();
	}
}

// 2. Out-of-range threshold is rejected with VALIDATION.
{
	const client = createClient();
	try {
		await assert.rejects(
			() => client.findDuplicates({ entityId: "alice", threshold: 1.5 }),
			(error) => {
				assert.equal(isMnemocyteError(error), true);
				assert.equal(error.code, "VALIDATION");
				return true;
			},
		);
	} finally {
		await client.close();
	}
}

// 3. Near-identical memories produce a pair; unrelated memory does not.
{
	const client = createClient();
	try {
		const morning = await client.remember({
			entityId: "alice",
			content: "coffee morning",
		});
		const early = await client.remember({
			entityId: "alice",
			content: "coffee early",
		});
		await client.remember({
			entityId: "alice",
			content: "weather sunny",
		});
		const pairs = await client.findDuplicates({
			entityId: "alice",
			threshold: 0.95,
		});
		assert.equal(pairs.length, 1);
		const pair = pairs[0];
		const ids = [pair.a.id, pair.b.id].sort();
		assert.deepEqual(ids, [morning.id, early.id].sort());
		assert.ok(pair.similarity >= 0.95 && pair.similarity <= 1);
	} finally {
		await client.close();
	}
}

// 4. Entity scoping: duplicates across entities are not surfaced.
{
	const client = createClient();
	try {
		await client.remember({ entityId: "alice", content: "coffee morning" });
		await client.remember({ entityId: "bob", content: "coffee early" });
		const alice = await client.findDuplicates({ entityId: "alice" });
		const bob = await client.findDuplicates({ entityId: "bob" });
		assert.equal(alice.length, 0);
		assert.equal(bob.length, 0);
	} finally {
		await client.close();
	}
}

// 5. Threshold filters: a high threshold drops near-but-not-exact pairs.
{
	const client = createClient();
	try {
		await client.remember({ entityId: "alice", content: "coffee morning" });
		await client.remember({ entityId: "alice", content: "coffee early" });
		const loose = await client.findDuplicates({
			entityId: "alice",
			threshold: 0.9,
		});
		const strict = await client.findDuplicates({
			entityId: "alice",
			threshold: 0.999999,
		});
		assert.equal(loose.length, 1);
		assert.equal(strict.length, 0);
	} finally {
		await client.close();
	}
}

// 6. types filter restricts the scan to listed types.
{
	const client = createClient();
	try {
		await client.remember({
			entityId: "alice",
			content: "coffee morning",
			type: "fact",
		});
		await client.remember({
			entityId: "alice",
			content: "coffee early",
			type: "preference",
		});
		const both = await client.findDuplicates({ entityId: "alice" });
		const factsOnly = await client.findDuplicates({
			entityId: "alice",
			types: ["fact"],
		});
		assert.equal(both.length, 1);
		assert.equal(factsOnly.length, 0);
	} finally {
		await client.close();
	}
}

// 7. tags filter requires both pair members to include all listed tags.
{
	const client = createClient();
	try {
		await client.remember({
			entityId: "alice",
			content: "coffee morning",
			tags: ["preferences"],
		});
		await client.remember({
			entityId: "alice",
			content: "coffee early",
			tags: ["preferences", "drink"],
		});
		const withMatch = await client.findDuplicates({
			entityId: "alice",
			tags: ["preferences"],
		});
		const withoutMatch = await client.findDuplicates({
			entityId: "alice",
			tags: ["preferences", "drink"],
		});
		assert.equal(withMatch.length, 1);
		assert.equal(withoutMatch.length, 0);
	} finally {
		await client.close();
	}
}

// 8. limit caps the number of returned pairs, ordered by similarity desc.
{
	const client = createClient();
	try {
		await client.remember({ entityId: "alice", content: "coffee morning" });
		await client.remember({ entityId: "alice", content: "coffee early" });
		await client.remember({ entityId: "alice", content: "tea afternoon" });
		const pairs = await client.findDuplicates({
			entityId: "alice",
			threshold: 0,
			limit: 1,
		});
		assert.equal(pairs.length, 1);
		// Highest-similarity pair must be the two coffee entries.
		const contents = [pairs[0].a.content, pairs[0].b.content].sort();
		assert.deepEqual(contents, ["coffee early", "coffee morning"]);
	} finally {
		await client.close();
	}
}

// 9. Superseded / expired memories are excluded by default.
{
	const client = createClient();
	try {
		await client.remember({ entityId: "alice", content: "coffee morning" });
		await client.remember({
			entityId: "alice",
			content: "coffee early",
			expiresAt: new Date(Date.now() - 60_000),
		});
		const defaults = await client.findDuplicates({ entityId: "alice" });
		const includeExpired = await client.findDuplicates({
			entityId: "alice",
			includeExpired: true,
		});
		assert.equal(defaults.length, 0);
		assert.equal(includeExpired.length, 1);
	} finally {
		await client.close();
	}
}

// 10. Emits a findDuplicates observability event with the pair count.
{
	const events = [];
	const client = createMnemocyte({
		embedder: dictionaryEmbedder(),
		observability: {
			onEvent(event) {
				events.push(event);
			},
		},
	});
	try {
		await client.remember({ entityId: "alice", content: "coffee morning" });
		await client.remember({ entityId: "alice", content: "coffee early" });
		const pairs = await client.findDuplicates({ entityId: "alice" });
		assert.equal(pairs.length, 1);
		const success = events.find(
			(event) =>
				event.operation === "findDuplicates" && event.phase === "success",
		);
		assert.equal(success?.entityId, "alice");
		assert.equal(success?.count, 1);
	} finally {
		await client.close();
	}
}

console.log("findDuplicates tests passed.");
