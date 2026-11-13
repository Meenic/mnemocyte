import { postgresJs } from "mnemocyte/postgres";
import postgres from "postgres";
import { afterAll, beforeAll, describe, test } from "vitest";
import {
	auditPhase,
	type BenchContext,
	describeServer,
	halfvecPhase,
	vectorPhase,
} from "./postgres/phases.js";
import { Report } from "./postgres/report.js";

/**
 * `EXPLAIN (ANALYZE, BUFFERS)` evidence for every default index, on a real
 * server. It drops and recreates Mnemocyte's tables, so it runs only with an
 * explicit `DATABASE_URL` (never `.env`) and
 * `MNEMOCYTE_BENCH_DISPOSABLE=1`. See docs/DEVELOPMENT.md.
 */
const databaseUrl = process.env.DATABASE_URL;
const disposable = process.env.MNEMOCYTE_BENCH_DISPOSABLE === "1";
const scale = Number(process.env.MNEMOCYTE_BENCH_SCALE ?? "1");
const runs = Number(process.env.MNEMOCYTE_BENCH_RUNS ?? "5");
const phases = (process.env.MNEMOCYTE_BENCH_PHASES ?? "halfvec,vector,audit")
	.split(",")
	.map((phase) => phase.trim());

if (databaseUrl && !disposable) {
	throw new Error(
		"postgres-plans drops Mnemocyte's tables: set MNEMOCYTE_BENCH_DISPOSABLE=1 to run it against a disposable database.",
	);
}
if (!(scale > 0 && scale <= 1) || !(Number.isInteger(runs) && runs >= 1)) {
	throw new Error(
		"MNEMOCYTE_BENCH_SCALE must be in (0, 1] and MNEMOCYTE_BENCH_RUNS a positive integer.",
	);
}

const HOUR = 3_600_000;

describe.skipIf(!databaseUrl)("Postgres index plans", () => {
	let sql: ReturnType<typeof postgres>;
	let ctx: BenchContext;

	beforeAll(async () => {
		// One connection, so session settings and setseed() stay on it.
		sql = postgres(databaseUrl ?? "", { max: 1, onnotice: () => {} });
		ctx = {
			db: postgresJs(sql),
			report: new Report(
				process.env.MNEMOCYTE_BENCH_OUT ??
					`bench-results/postgres-plans-${new Date().toISOString().replaceAll(":", "-")}.md`,
			),
			runs,
			scale,
		};
		await describeServer(ctx);
		ctx.report.flush(`Server (scale ${scale}, ${runs} runs per case)`);
	});

	afterAll(async () => {
		await sql?.end();
	});

	test.runIf(phases.includes("halfvec"))(
		"halfvec(3072): search and duplicates",
		{ timeout: 2 * HOUR },
		async () => {
			await halfvecPhase(ctx);
			ctx.report.flush("halfvec(3072)");
		},
	);

	test.runIf(phases.includes("vector"))(
		"vector(1536): every default index",
		{ timeout: 3 * HOUR },
		async () => {
			await vectorPhase(ctx);
			ctx.report.flush("vector(1536)");
		},
	);

	test.runIf(phases.includes("audit"))(
		"pruneAuditLog over a large backlog",
		{ timeout: 2 * HOUR },
		async () => {
			await auditPhase(ctx);
			ctx.report.flush("Audit retention");
		},
	);
});
