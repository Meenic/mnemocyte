import {
	createMemory,
	type Embedder,
	type MemoryScope,
	type MnemocyteObservation,
	migrate,
	type TokenCounter,
} from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

/** A client method called with an input the types would reject. */
type UntypedMethod = (input?: unknown) => Promise<unknown>;

const NAMESPACE = "app";
const scope: MemoryScope = { namespace: NAMESPACE, entityId: "u1" };
const selector = { namespace: NAMESPACE };

function setup(config: { namespace?: string } = {}) {
	let embedCalls = 0;
	const embedder: Embedder = {
		model: "strict-inputs-test",
		dimensions: 3,
		async embed(texts) {
			embedCalls += 1;
			return texts.map((text) => [text.length, 1, text.charCodeAt(0)]);
		},
	};
	const events: MnemocyteObservation[] = [];
	const memory = createMemory({
		...config,
		embedder,
		observability: {
			onEvent(event) {
				events.push(event);
			},
		},
	});
	return { memory, events, embedCalls: () => embedCalls };
}

/** A valid input for each method, without its scope or selector. */
const INPUTS: Readonly<
	Record<
		string,
		{ input: Record<string, unknown>; selector?: boolean; optional?: boolean }
	>
> = {
	add: { input: { content: "tea" } },
	addMany: { input: { memories: [{ content: "tea" }] } },
	search: { input: { query: "tea" } },
	get: { input: { id: "missing" } },
	list: { input: {}, optional: true },
	update: { input: { id: "missing", content: "coffee" } },
	delete: { input: { id: "missing" } },
	deleteScope: { input: {}, optional: true },
	context: { input: { query: "tea" } },
	prune: { input: { expired: true }, selector: true },
	findDuplicates: { input: {}, optional: true },
	listAuditLog: { input: {}, selector: true, optional: true },
	pruneAuditLog: { input: { before: new Date() }, selector: true },
	stats: { input: {}, selector: true, optional: true },
	consolidate: { input: { survivorId: "a", supersededIds: ["b"] } },
	findDuplicatesPage: { input: {}, optional: true },
};

function methodOf(client: object, name: string): UntypedMethod {
	const methods =
		name === "findDuplicatesPage"
			? (client as { experimental: Record<string, UntypedMethod> }).experimental
			: (client as Record<string, UntypedMethod>);
	const method = methods[name];
	if (method === undefined) {
		throw new Error(`No method ${name}.`);
	}
	return method;
}

describe("unknown keys on method inputs", () => {
	test.each(Object.keys(INPUTS))(
		"%s throws VALIDATION for an unknown key before embedding",
		async (name) => {
			const { memory, events, embedCalls } = setup();
			const { input, selector: bySelector } = INPUTS[name] ?? { input: {} };
			const call = methodOf(memory, name);
			for (const value of ["x", undefined]) {
				const error = await expectMnemocyteError(
					call({
						...input,
						scope: bySelector ? selector : scope,
						misspelled: value,
					}),
					"VALIDATION",
				);
				expect(error.message).toContain(
					`${name} does not accept "misspelled". Accepted keys: `,
				);
			}
			expect(embedCalls()).toBe(0);
			const errors = events.filter((event) => event.phase === "error");
			expect(errors.map((event) => event.operation)).toEqual([name, name]);
		},
	);

	test.each(Object.keys(INPUTS))(
		"%s on a bound client throws VALIDATION for an unknown key",
		async (name) => {
			const { memory, embedCalls } = setup();
			const bound = memory.for(scope);
			const { input } = INPUTS[name] ?? { input: {} };
			await expect(
				methodOf(bound, name)({ ...input, misspelled: true }),
			).rejects.toThrow(
				expect.objectContaining({
					code: "VALIDATION",
					message: expect.stringContaining(
						`${name} does not accept "misspelled".`,
					),
				}),
			);
			expect(embedCalls()).toBe(0);
		},
	);

	test.each(Object.keys(INPUTS))(
		"%s on a default-namespace client throws VALIDATION for an unknown key",
		async (name) => {
			const { memory } = setup({ namespace: NAMESPACE });
			const { input, selector: bySelector } = INPUTS[name] ?? { input: {} };
			await expect(
				methodOf(
					memory,
					name,
				)({
					...input,
					scope: bySelector ? {} : { entityId: "u1" },
					misspelled: true,
				}),
			).rejects.toThrow(
				expect.objectContaining({
					code: "VALIDATION",
					message: expect.stringContaining(
						`${name} does not accept "misspelled".`,
					),
				}),
			);
		},
	);

	test.each(Object.keys(INPUTS))(
		"%s throws VALIDATION for a null or missing input on every client",
		async (name) => {
			for (const config of [{}, { namespace: NAMESPACE }]) {
				const { memory, events, embedCalls } = setup(config);
				const call = methodOf(memory, name);
				for (const value of [null, undefined, "tea", ["tea"]]) {
					const error = await expectMnemocyteError(call(value), "VALIDATION");
					expect(error).not.toBeInstanceOf(TypeError);
					expect(error.message).toBe(`${name} input must be an object.`);
				}
				expect(embedCalls()).toBe(0);
				expect(
					events
						.filter((event) => event.phase === "error")
						.map((event) => event.operation),
				).toEqual([name, name, name, name]);
				for (const value of [null, "tea"]) {
					await expectMnemocyteError(
						methodOf(memory.for(scope), name)(value),
						"VALIDATION",
					);
				}
			}
		},
	);

	test("a known key still passes", async () => {
		const { memory } = setup();
		const bound = memory.for(scope);
		await memory.add({ scope, content: "tea", kind: "preference" });
		expect(
			await memory.search({ scope, query: "tea", kinds: ["preference"] }),
		).toHaveLength(1);
		for (const [name, { optional }] of Object.entries(INPUTS)) {
			if (optional) {
				// An omitted optional input is an empty object, not unknown keys.
				await expect(methodOf(bound, name)()).resolves.toBeDefined();
			}
		}
	});

	test("search names the replacement of before and after on every client", async () => {
		const { memory } = setup({ namespace: NAMESPACE });
		const bound = memory.for(scope);
		for (const call of [
			(input: Record<string, unknown>) =>
				methodOf(memory, "search")({ ...input, scope: { entityId: "u1" } }),
			(input: Record<string, unknown>) => methodOf(bound, "search")(input),
		]) {
			await expect(call({ query: "tea", after: new Date() })).rejects.toThrow(
				'search does not accept "after": it was renamed "createdAfter".',
			);
		}
	});

	test("bound stats takes no input", async () => {
		const { memory } = setup();
		const stats = methodOf(memory.for(scope), "stats");
		await expect(stats({ namespace: NAMESPACE })).rejects.toThrow(
			'stats does not accept "namespace".',
		);
		await expect(stats({})).resolves.toMatchObject({ memoryCount: 0 });
	});

	test("migrate throws VALIDATION for an unknown key", async () => {
		const { memory } = setup();
		const error = await expectMnemocyteError(
			migrate({ memory, dryrun: true } as unknown as Parameters<
				typeof migrate
			>[0]),
			"VALIDATION",
		);
		expect(error.message).toContain('migrate does not accept "dryrun".');
	});
});

describe("unknown keys in nested inputs", () => {
	test("a scope key is checked on reads, writes and for()", async () => {
		const { memory, embedCalls } = setup();
		const typo = { ...scope, agentid: "a" };
		for (const name of ["add", "search", "list", "context"]) {
			const { input } = INPUTS[name] ?? { input: {} };
			await expect(
				methodOf(memory, name)({ ...input, scope: typo }),
			).rejects.toThrow(
				expect.objectContaining({
					code: "VALIDATION",
					message: expect.stringContaining('scope does not accept "agentid".'),
				}),
			);
		}
		expect(() => memory.for(typo as MemoryScope)).toThrow(
			expect.objectContaining({ code: "VALIDATION" }),
		);
		expect(embedCalls()).toBe(0);
	});

	test("a scope key the default namespace fills is still checked", async () => {
		const { memory } = setup({ namespace: NAMESPACE });
		await expect(
			methodOf(
				memory,
				"search",
			)({
				scope: { namespce: "other", entityId: "u1" },
				query: "tea",
			}),
		).rejects.toThrow('scope does not accept "namespce".');
	});

	test("a misspelled scope key on deleteScope and prune deletes nothing", async () => {
		const { memory } = setup();
		await memory.add({ scope: { ...scope, sessionId: "s1" }, content: "tea" });
		await memory.add({ scope: { ...scope, sessionId: "s2" }, content: "milk" });
		await expectMnemocyteError(
			methodOf(memory, "deleteScope")({ scope: { ...scope, sessionID: "s1" } }),
			"VALIDATION",
		);
		await expectMnemocyteError(
			methodOf(
				memory,
				"prune",
			)({
				scope: { namespace: NAMESPACE, entityID: "other" },
				createdBefore: new Date(Date.now() + 60_000),
			}),
			"VALIDATION",
		);
		expect(await memory.stats({ scope: selector })).toMatchObject({
			memoryCount: 2,
		});
	});

	test("an addMany memory with an unknown key stores nothing", async () => {
		const { memory, embedCalls } = setup();
		const error = await expectMnemocyteError(
			methodOf(
				memory,
				"addMany",
			)({
				scope,
				memories: [
					{ content: "tea" },
					{ content: "milk", expiresat: new Date(Date.now() + 1000) },
				],
			}),
			"VALIDATION",
		);
		expect(error.message).toContain(
			'memories[1] does not accept "expiresat". Accepted keys: ',
		);
		expect(embedCalls()).toBe(0);
		expect((await memory.list({ scope })).memories).toEqual([]);
	});

	test("metadata and tokenCounter keep their own keys", async () => {
		const { memory } = setup();
		const metadata = { anything: { nested: [1, { deep: true }] }, kind: "x" };
		const added = await memory.add({ scope, content: "tea", metadata });
		expect(added.metadata).toEqual(metadata);
		await memory.update({ scope, id: added.id, metadata: { other: 1 } });

		class WordCounter implements TokenCounter {
			readonly calls: number[] = [];
			count(text: string): number {
				this.calls.push(text.length);
				return text.split(/\s+/).length;
			}
		}
		const tokenCounter = new WordCounter();
		await memory.context({ scope, query: "tea", tokenCounter });
		expect(tokenCounter.calls.length).toBeGreaterThan(0);
	});
});
