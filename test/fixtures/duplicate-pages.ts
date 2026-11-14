import type {
	DuplicatePage,
	DuplicatePair,
	FindDuplicatesPageInput,
	MemoryClient,
} from "mnemocyte";
import { expect } from "vitest";
import { expectDefined, expectMnemocyteError } from "../helpers.js";
import type { ScopeFor } from "./survivor-deletes.js";

function pairKey(pair: DuplicatePair): string {
	return `${pair.a.id} ${pair.b.id}`;
}

/** Every page of a run, from the first until `nextCursor` is `null`. */
async function allPages(
	client: MemoryClient,
	input: FindDuplicatesPageInput,
): Promise<DuplicatePage[]> {
	const pages: DuplicatePage[] = [];
	let cursor: string | undefined;
	do {
		const page = await client.experimental.findDuplicatesPage({
			...input,
			...(cursor === undefined ? {} : { cursor }),
		});
		pages.push(page);
		cursor = page.nextCursor ?? undefined;
		expect(pages.length).toBeLessThan(100);
	} while (cursor !== undefined);
	return pages;
}

function expectBestFirst(pairs: readonly DuplicatePair[]): void {
	for (const pair of pairs) {
		expect(pair.a.id < pair.b.id).toBe(true);
	}
	const sorted = [...pairs].sort(
		(x, y) =>
			y.similarity - x.similarity ||
			(x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0) ||
			(x.b.id < y.b.id ? -1 : x.b.id > y.b.id ? 1 : 0),
	);
	expect(pairs.map(pairKey)).toEqual(sorted.map(pairKey));
}

/**
 * `experimental.findDuplicatesPage`, the same on every backend: a run of
 * pages returns exactly the pairs of `findDuplicates`, each once, in the
 * page of the memory that found the other (the smaller id's when both did).
 * The client's embedder must be the contract embedder (one dense random
 * vector per word, summed).
 */
export async function verifyDuplicatePages(
	client: MemoryClient,
	scopeFor: ScopeFor,
): Promise<void> {
	// Ownership. With one neighbor each, base and near pick each other and far
	// picks near, so near–far is found only from far's side. The contents go
	// to the memories in id order, so far has the largest id and its page
	// keeps the pair only after checking that near's neighbors do not hold
	// it; base–near is found from both sides and kept by base's page alone.
	const trio = scopeFor("pages-trio");
	const placeholders = await client.addMany({
		scope: trio,
		memories: [
			{ content: "x one" },
			{ content: "x two" },
			{ content: "x three" },
		],
	});
	const [baseId, nearId, farId] = placeholders.map(({ id }) => id).sort();
	const contents: Array<[string | undefined, string]> = [
		[baseId, "amber birch cedar dune"],
		[nearId, "amber birch cedar dune ember"],
		[farId, "amber birch cedar dune ember fjord grove heath"],
	];
	for (const [id, content] of contents) {
		await client.update({ scope: trio, id: expectDefined(id), content });
	}
	const trioPages = await allPages(client, {
		scope: trio,
		threshold: 0.6,
		neighbors: 1,
		batchSize: 1,
	});
	expect(trioPages.map((page) => page.compared)).toEqual([1, 1, 1, 0]);
	expect(
		trioPages.map((page) => page.pairs.map((pair) => [pair.a.id, pair.b.id])),
	).toEqual([[[baseId, nearId]], [], [[nearId, farId]], []]);
	expect(trioPages.at(-1)?.nextCursor).toBeNull();

	// Pages of every size give the pairs of one `findDuplicates` call.
	const scope = scopeFor("pages");
	const added = await client.addMany({
		scope,
		memories: [
			{ content: "amber birch cedar dune" },
			{ content: "amber birch cedar dune ember", kind: "preference" },
			{ content: "amber birch cedar dune ember fjord grove heath" },
			{ content: "iris juniper kelp lotus", kind: "preference" },
			{ content: "iris juniper kelp lotus moss" },
			{ content: "iris juniper kelp", kind: "preference" },
			{ content: "amber iris noon oak" },
			{ content: "pine quartz reed sage" },
		],
	});
	const ids = added.map(({ id }) => id).sort();
	const cases: Array<Omit<FindDuplicatesPageInput, "scope">> = [];
	for (const neighbors of [1, 2, 3, 7]) {
		for (const batchSize of [1, 2, 3, 8, 500]) {
			cases.push({ threshold: 0.4, neighbors, batchSize });
		}
	}
	cases.push({
		threshold: 0.4,
		neighbors: 1,
		batchSize: 2,
		kinds: ["preference"],
	});
	for (const input of cases) {
		const pages = await allPages(client, { ...input, scope });
		const batchSize = expectDefined(input.batchSize);
		const filtered =
			input.kinds === undefined
				? ids
				: added
						.filter((memory) => memory.kind === "preference")
						.map(({ id }) => id)
						.sort();
		// Each page compares the next `batchSize` memories in id order; a
		// full last page is followed by an empty one.
		expect(pages.map((page) => page.compared)).toEqual([
			...Array.from(
				{ length: Math.floor(filtered.length / batchSize) },
				() => batchSize,
			),
			filtered.length % batchSize,
		]);
		let offset = 0;
		for (const page of pages) {
			expectBestFirst(page.pairs);
			const compared = new Set(filtered.slice(offset, offset + page.compared));
			for (const pair of page.pairs) {
				expect(compared.has(pair.a.id) || compared.has(pair.b.id)).toBe(true);
			}
			offset += page.compared;
		}
		const keys = pages.flatMap((page) => page.pairs.map(pairKey));
		expect(new Set(keys).size).toBe(keys.length);
		const whole = await client.findDuplicates({
			scope,
			limit: 1000,
			threshold: input.threshold ?? 0.95,
			neighbors: input.neighbors ?? 10,
			...(input.kinds === undefined ? {} : { kinds: input.kinds }),
		});
		expect([...keys].sort()).toEqual(whole.map(pairKey).sort());
	}

	// A bound client pages the same way.
	const bound = client.for(scope);
	await expect(
		allPages(client, { scope, threshold: 0.4, batchSize: 3 }),
	).resolves.toEqual(
		await (async () => {
			const pages: DuplicatePage[] = [];
			let cursor: string | undefined;
			do {
				const page = await bound.experimental.findDuplicatesPage({
					threshold: 0.4,
					batchSize: 3,
					...(cursor === undefined ? {} : { cursor }),
				});
				pages.push(page);
				cursor = page.nextCursor ?? undefined;
			} while (cursor !== undefined);
			return pages;
		})(),
	);

	// Another scope sees none of these memories.
	await expect(
		client.experimental.findDuplicatesPage({
			scope: scopeFor("pages-empty"),
			threshold: 0,
		}),
	).resolves.toEqual({ pairs: [], nextCursor: null, compared: 0 });

	for (const batchSize of [0, 1001, 1.5]) {
		await expectMnemocyteError(
			client.experimental.findDuplicatesPage({ scope, batchSize }),
			"VALIDATION",
		);
	}
	const list = await client.list({ scope, limit: 1 });
	for (const cursor of ["", "nope", "e30", expectDefined(list.nextCursor)]) {
		await expectMnemocyteError(
			client.experimental.findDuplicatesPage({ scope, cursor }),
			"VALIDATION",
		);
	}
	await expectMnemocyteError(
		client.experimental.findDuplicatesPage({ scope, neighbors: 0 }),
		"VALIDATION",
	);
	await expectMnemocyteError(
		bound.experimental.findDuplicatesPage({
			scope,
		} as unknown as Parameters<
			typeof bound.experimental.findDuplicatesPage
		>[0]),
		"VALIDATION",
	);
	await expectMnemocyteError(
		client.experimental.findDuplicatesPage({
			scope,
			signal: AbortSignal.abort(),
		}),
		"ABORTED",
	);
}
