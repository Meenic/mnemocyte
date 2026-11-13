import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Measurement } from "./explain.js";

export interface ReportRow {
	case: string;
	variant: string;
	measurement?: Measurement;
	/** Free text for rows that are not a single plan (wall times, recall). */
	note?: string;
}

function formatMs(ms: number): string {
	if (ms >= 1000) {
		return `${(ms / 1000).toFixed(2)} s`;
	}
	if (ms >= 10) {
		return `${ms.toFixed(1)} ms`;
	}
	return `${ms.toFixed(2)} ms`;
}

function planText(m: Measurement): string {
	const parts = [m.scans.join(", ")];
	if (m.arbiters.length > 0) {
		parts.push(`arbiter ${m.arbiters.join(", ")}`);
	}
	if (m.sorts.length > 0) {
		parts.push(m.sorts.join(", "));
	}
	parts.push(`${Math.round(m.scanRows)} rows scanned`);
	const searches = Object.entries(m.indexSearches);
	if (searches.length > 0) {
		parts.push(
			`index searches: ${searches.map(([name, count]) => `${name} ${count}`).join(", ")}`,
		);
	}
	return parts.join("; ");
}

function timeText(m: Measurement): string {
	const extras: string[] = [];
	if (m.triggerMs > 0) {
		extras.push(`triggers ${formatMs(m.triggerMs)}`);
	}
	if (m.jitMs > 0) {
		extras.push(`JIT ${formatMs(m.jitMs)}`);
	}
	const median =
		m.runs > 1
			? `median of ${m.runs}, slowest ${formatMs(m.slowestMs)}`
			: "1 run";
	return `${formatMs(m.executionMs)} (${median}${extras.length > 0 ? `; ${extras.join(", ")}` : ""})`;
}

/** Collects rows per section and prints them as markdown tables. */
export class Report {
	private readonly sections = new Map<string, ReportRow[]>();
	private readonly notes: string[] = [];

	/** Appends every flushed section to `outFile`, creating its folder. */
	constructor(private readonly outFile: string | undefined) {
		if (outFile) {
			mkdirSync(dirname(outFile), { recursive: true });
		}
	}

	add(section: string, row: ReportRow): void {
		const rows = this.sections.get(section) ?? [];
		rows.push(row);
		this.sections.set(section, rows);
		const value = row.measurement
			? `${planText(row.measurement)} | ${timeText(row.measurement)} | ${row.measurement.hit + row.measurement.read}`
			: (row.note ?? "");
		console.log(`[bench] ${section} | ${row.case} | ${row.variant} | ${value}`);
	}

	note(text: string): void {
		this.notes.push(text);
		console.log(`[bench] ${text}`);
	}

	/** Prints every section collected since the last flush and clears them. */
	flush(title: string): string {
		const lines = [`## ${title}`, "", ...this.notes.map((n) => `- ${n}`), ""];
		for (const [section, rows] of this.sections) {
			lines.push(`### ${section}`, "");
			lines.push("| Case | Variant | Plan | Time | Buffers (hit + read) |");
			lines.push("|---|---|---|---|---|");
			for (const row of rows) {
				const m = row.measurement;
				lines.push(
					m
						? `| ${row.case} | ${row.variant} | ${planText(m)} | ${timeText(m)} | ${m.hit} + ${m.read} |`
						: `| ${row.case} | ${row.variant} | ${row.note ?? ""} | | |`,
				);
			}
			lines.push("");
			for (const row of rows) {
				if (row.measurement?.text) {
					lines.push(
						`<details><summary>${row.case}, ${row.variant}</summary>`,
						"",
						"```",
						row.measurement.text,
						"```",
						"",
						"</details>",
						"",
					);
				}
			}
		}
		const text = lines.join("\n");
		console.log(text);
		if (this.outFile) {
			appendFileSync(this.outFile, `${text}\n`);
		}
		this.sections.clear();
		this.notes.length = 0;
		return text;
	}
}
