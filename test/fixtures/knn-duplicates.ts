import type { DuplicatePair, MemoryClient } from "mnemocyte";
import { expect } from "vitest";
import { expectDefined, expectMnemocyteError } from "../helpers.js";
import type { ScopeFor } from "./survivor-deletes.js";

function pairIds(pairs: readonly DuplicatePair[]): string[][] {
	return pairs.map((pair) => [pair.a.id, pair.b.id]);
}

/**
 * Nearest-neighbor duplicate search, the same on every backend. The client's
 * embedder must give texts that share words similar vectors (the contract
 * embedder sums one dense random vector per word), so the similarities are:
 * `near` ~0.89 to `base`, `far` ~0.79 to `near` and ~0.71 to `base`.
 */
export async function verifyKnnDuplicates(
	client: MemoryClient,
	scopeFor: ScopeFor,
): Promise<void> {
	const scope = scopeFor("knn");
	const [base, near, far] = await client.addMany({
		scope,
		memories: [
			{ content: "amber birch cedar dune" },
			{ content: "amber birch cedar dune ember" },
			{ content: "amber birch cedar dune ember fjord grove heath" },
		],
	});
	const ids = {
		base: expectDefined(base).id,
		near: expectDefined(near).id,
		far: expectDefined(far).id,
	};
	const ordered = (x: string, y: string) => (x < y ? [x, y] : [y, x]);

	// Every memory compares with both others: three pairs, most similar first,
	// each once, with the smaller id as `a`.
	const all = await client.findDuplicates({ scope, threshold: 0.6 });
	expect(pairIds(all)).toEqual([
		ordered(ids.base, ids.near),
		ordered(ids.near, ids.far),
		ordered(ids.base, ids.far),
	]);
	for (const pair of all) {
		expect(pair.a.id < pair.b.id).toBe(true);
	}
	const similarities = all.map((pair) => pair.similarity);
	expect(similarities).toEqual([...similarities].sort((x, y) => y - x));

	// One neighbor each: base and near pick each other, far picks near. The
	// base–far pair is nobody's nearest, so it is not found.
	const one = await client.findDuplicates({
		scope,
		threshold: 0.6,
		neighbors: 1,
	});
	expect(pairIds(one)).toEqual([
		ordered(ids.base, ids.near),
		ordered(ids.near, ids.far),
	]);

	// The threshold applies after the neighbors are chosen, and `limit` after
	// pairs are merged.
	await expect(
		client
			.findDuplicates({ scope, threshold: 0.85 })
			.then((pairs) => pairIds(pairs)),
	).resolves.toEqual([ordered(ids.base, ids.near)]);
	await expect(
		client
			.findDuplicates({ scope, threshold: 0.6, limit: 2 })
			.then((pairs) => pairIds(pairs)),
	).resolves.toEqual([ordered(ids.base, ids.near), ordered(ids.near, ids.far)]);

	// A superseded memory is not anyone's neighbor unless asked for.
	await client.consolidate({
		scope,
		survivorId: ids.base,
		supersededIds: [ids.near],
	});
	await expect(
		client
			.findDuplicates({ scope, threshold: 0.6, neighbors: 1 })
			.then((pairs) => pairIds(pairs)),
	).resolves.toEqual([ordered(ids.base, ids.far)]);
	await expect(
		client
			.findDuplicates({
				scope,
				threshold: 0.6,
				neighbors: 1,
				includeSuperseded: true,
			})
			.then((pairs) => pairIds(pairs)),
	).resolves.toEqual([ordered(ids.base, ids.near), ordered(ids.near, ids.far)]);

	for (const neighbors of [0, 101, 1.5]) {
		await expectMnemocyteError(
			client.findDuplicates({ scope, neighbors }),
			"VALIDATION",
		);
	}
}
