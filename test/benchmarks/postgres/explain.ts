import type { SqlExecutor, SqlStatement } from "../../../src/sql/executor.js";

/** Thrown by a {@link Recorder} to stop a statement before it runs. */
export class CapturedStatement extends Error {
	constructor(readonly statement: SqlStatement) {
		super("Statement captured for the benchmark.");
	}
}

/** Thrown inside a measurement transaction to roll it back. */
class Rollback extends Error {
	constructor(readonly value: unknown) {
		super("Rolled back by the benchmark.");
	}
}

export interface Recorder {
	/** The executor to give the memory client. */
	executor: SqlExecutor;
	/** Every statement sent since the last {@link Recorder.clear}, in order. */
	readonly log: SqlStatement[];
	clear(): void;
	/**
	 * Statements for which `match` returns true reject with
	 * {@link CapturedStatement} instead of running, so a write can be measured
	 * in a rolled-back transaction without the library committing it.
	 */
	block(match: ((statement: SqlStatement) => boolean) | undefined): void;
	/** Awaited before each statement runs. */
	before(hook: ((statement: SqlStatement) => Promise<void>) | undefined): void;
}

/** Wraps `inner` so every statement the library sends is recorded. */
export function createRecorder(inner: SqlExecutor): Recorder {
	const log: SqlStatement[] = [];
	let blocked: ((statement: SqlStatement) => boolean) | undefined;
	let hook: ((statement: SqlStatement) => Promise<void>) | undefined;

	async function admit(statement: SqlStatement): Promise<void> {
		log.push(statement);
		if (blocked?.(statement)) {
			throw new CapturedStatement(statement);
		}
		await hook?.(statement);
	}

	function wrap(exec: SqlExecutor): SqlExecutor {
		const wrapped: SqlExecutor = {
			async query<Row>(
				sql: string,
				params: readonly unknown[],
				options?: Parameters<SqlExecutor["query"]>[2],
			) {
				await admit({ sql, params });
				return exec.query<Row>(sql, params, options);
			},
		};
		if (exec.transaction) {
			const transaction = exec.transaction.bind(exec);
			wrapped.transaction = (fn) => transaction((tx) => fn(wrap(tx)));
		}
		if (exec.batch) {
			const batch = exec.batch.bind(exec);
			wrapped.batch = async (statements, options) => {
				for (const statement of statements) {
					await admit(statement);
				}
				return batch(statements, options);
			};
		}
		return wrapped;
	}

	return {
		executor: wrap(inner),
		log,
		clear: () => {
			log.length = 0;
		},
		block: (match) => {
			blocked = match;
		},
		before: (next) => {
			hook = next;
		},
	};
}

/** Runs `fn`, expecting it to stop at a blocked statement, and returns it. */
export async function capture(
	fn: () => Promise<unknown>,
): Promise<SqlStatement> {
	try {
		await fn();
	} catch (error) {
		// The store wraps driver errors ("DB"), so look along the cause chain.
		for (let cause: unknown = error; cause; ) {
			if (cause instanceof CapturedStatement) {
				return cause.statement;
			}
			cause = cause instanceof Error ? cause.cause : undefined;
		}
		throw error;
	}
	throw new Error("The call finished without reaching a blocked statement.");
}

/** The last recorded statement whose text matches `pattern`. */
export function findStatement(
	log: readonly SqlStatement[],
	pattern: string | RegExp,
): SqlStatement {
	const matches = (sql: string) =>
		typeof pattern === "string" ? sql.includes(pattern) : pattern.test(sql);
	for (let index = log.length - 1; index >= 0; index -= 1) {
		const statement = log[index];
		if (statement && matches(statement.sql)) {
			return statement;
		}
	}
	throw new Error(`No recorded statement matches ${String(pattern)}.`);
}

/** Runs `fn` in a transaction that always rolls back, and returns its value. */
export async function rolledBack<T>(
	db: SqlExecutor,
	fn: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
	if (!db.transaction) {
		throw new Error("The benchmark needs an executor with transaction().");
	}
	try {
		await db.transaction(async (tx) => {
			throw new Rollback(await fn(tx));
		});
	} catch (error) {
		if (error instanceof Rollback) {
			return error.value as T;
		}
		throw error;
	}
	throw new Error("unreachable");
}

interface PlanNode {
	"Node Type": string;
	"Relation Name"?: string;
	"Index Name"?: string;
	"Sort Method"?: string;
	"Shared Hit Blocks"?: number;
	"Shared Read Blocks"?: number;
	"Index Searches"?: number;
	"Actual Rows"?: number;
	"Actual Loops"?: number;
	"Conflict Arbiter Indexes"?: string[];
	Plans?: PlanNode[];
}

interface ExplainOutput {
	Plan: PlanNode;
	"Planning Time": number;
	"Execution Time": number;
	Triggers?: Array<{ "Trigger Name": string; Time: number; Calls: number }>;
	JIT?: { Timing?: { Total?: number } };
}

export interface PlanRun {
	executionMs: number;
	planningMs: number;
	hit: number;
	read: number;
	/** Scan nodes as `Node Type (index or table)`, in plan order, deduplicated. */
	scans: string[];
	/** Every index the plan reads. */
	indexes: string[];
	/** Sort methods used, such as `top-N heapsort`. */
	sorts: string[];
	/** `ON CONFLICT` arbiter indexes. */
	arbiters: string[];
	/** Rows returned by scan nodes, over all their loops. */
	scanRows: number;
	/**
	 * `Index Searches` (Postgres 18+) per index, summed over the nodes that
	 * read it: the number of descents from the root, over all loops.
	 */
	indexSearches: Record<string, number>;
	triggerMs: number;
	jitMs: number;
}

function walk(node: PlanNode, visit: (node: PlanNode) => void): void {
	visit(node);
	for (const child of node.Plans ?? []) {
		walk(child, visit);
	}
}

function shortName(name: string): string {
	return name.replace(/^mnemocyte_(memories|events)_/, "");
}

function parseExplain(value: unknown): ExplainOutput {
	const parsed =
		typeof value === "string" ? (JSON.parse(value) as unknown) : value;
	if (!Array.isArray(parsed) || parsed.length !== 1) {
		throw new Error("Unexpected EXPLAIN (FORMAT JSON) output.");
	}
	return parsed[0] as ExplainOutput;
}

export function summarizePlan(output: ExplainOutput): PlanRun {
	const scans: string[] = [];
	const indexes: string[] = [];
	const sorts: string[] = [];
	const arbiters: string[] = [];
	const indexSearches: Record<string, number> = {};
	let scanRows = 0;
	walk(output.Plan, (node) => {
		if (node["Node Type"].includes("Scan")) {
			scanRows += (node["Actual Rows"] ?? 0) * (node["Actual Loops"] ?? 1);
			const target = node["Index Name"] ?? node["Relation Name"];
			const label = target
				? `${node["Node Type"]} (${shortName(target)})`
				: node["Node Type"];
			if (!scans.includes(label)) {
				scans.push(label);
			}
		}
		for (const arbiter of node["Conflict Arbiter Indexes"] ?? []) {
			arbiters.push(shortName(arbiter));
		}
		for (const index of [
			node["Index Name"],
			...(node["Conflict Arbiter Indexes"] ?? []),
		]) {
			if (index && !indexes.includes(index)) {
				indexes.push(index);
			}
		}
		const sort = node["Sort Method"];
		if (sort && !sorts.includes(sort)) {
			sorts.push(sort);
		}
		const searched = node["Index Name"];
		if (searched && node["Index Searches"] !== undefined) {
			const name = shortName(searched);
			indexSearches[name] = (indexSearches[name] ?? 0) + node["Index Searches"];
		}
	});
	return {
		executionMs: output["Execution Time"],
		planningMs: output["Planning Time"],
		hit: output.Plan["Shared Hit Blocks"] ?? 0,
		read: output.Plan["Shared Read Blocks"] ?? 0,
		scans,
		indexes,
		sorts,
		arbiters,
		scanRows,
		indexSearches,
		triggerMs: (output.Triggers ?? []).reduce((sum, t) => sum + t.Time, 0),
		jitMs: output.JIT?.Timing?.Total ?? 0,
	};
}

/** `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` of one statement on `tx`. */
export async function explainOnce(
	tx: SqlExecutor,
	statement: SqlStatement,
): Promise<PlanRun> {
	const rows = await tx.query<Record<string, unknown>>(
		`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`,
		statement.params,
	);
	const first = rows[0];
	if (!first) {
		throw new Error("EXPLAIN returned no rows.");
	}
	return summarizePlan(parseExplain(Object.values(first)[0]));
}

export interface MeasureOptions {
	/** Statements that run before the measured one in each run, such as `set_config`. */
	prelude?: readonly SqlStatement[];
	/** DDL that runs once, inside the rolled-back transaction, before the runs. */
	setup?: readonly string[];
	/** Measured runs after one warm-up run. */
	runs: number;
	/** Skip the warm-up run (for statements that take minutes). */
	cold?: boolean;
}

export interface Measurement extends PlanRun {
	runs: number;
	/** The text plan of one more run, for warm measurements. */
	text?: string;
}

/**
 * Measures `statement` with `EXPLAIN (ANALYZE, BUFFERS)` in a transaction
 * that rolls back: `setup` once, then one warm-up run and `runs` measured
 * runs, each inside a savepoint that is rolled back, so writes measure
 * against the same data every time and `SET LOCAL` settings from the prelude
 * end with the run. Reports the run with the median execution time.
 */
export async function measure(
	db: SqlExecutor,
	statement: SqlStatement,
	options: MeasureOptions,
): Promise<Measurement> {
	return rolledBack(db, async (tx) => {
		for (const ddl of options.setup ?? []) {
			await tx.query(ddl, []);
		}
		const results: PlanRun[] = [];
		const total = options.runs + (options.cold ? 0 : 1);
		for (let run = 0; run < total; run += 1) {
			await tx.query("SAVEPOINT mnemocyte_bench", []);
			for (const step of options.prelude ?? []) {
				await tx.query(step.sql, step.params);
			}
			const result = await explainOnce(tx, statement);
			await tx.query("ROLLBACK TO SAVEPOINT mnemocyte_bench", []);
			if (options.cold || run > 0) {
				results.push(result);
			}
		}
		const sorted = [...results].sort((a, b) => a.executionMs - b.executionMs);
		const median = sorted[Math.floor((sorted.length - 1) / 2)];
		if (!median) {
			throw new Error("No measured runs.");
		}
		if (options.cold) {
			return { ...median, runs: results.length };
		}
		await tx.query("SAVEPOINT mnemocyte_bench", []);
		for (const step of options.prelude ?? []) {
			await tx.query(step.sql, step.params);
		}
		const lines = await tx.query<Record<string, unknown>>(
			`EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`,
			statement.params,
		);
		await tx.query("ROLLBACK TO SAVEPOINT mnemocyte_bench", []);
		const text = lines.map((line) => String(Object.values(line)[0])).join("\n");
		return { ...median, runs: results.length, text };
	});
}

/** Rows of a statement run in a rolled-back transaction after `prelude`. */
export async function runRolledBack<Row>(
	db: SqlExecutor,
	statement: SqlStatement,
	prelude: readonly SqlStatement[] = [],
): Promise<Row[]> {
	return rolledBack(db, async (tx) => {
		for (const step of prelude) {
			await tx.query(step.sql, step.params);
		}
		return tx.query<Row>(statement.sql, statement.params);
	});
}
