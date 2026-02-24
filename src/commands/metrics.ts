/**
 * CLI command: overstory metrics [--last <n>] [--json]
 *
 * Shows metrics summary from SQLite store: session durations, success rates,
 * merge tier distribution, agent utilization.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { createMetricsStore } from "../metrics/store.ts";

interface MetricsOpts {
	last?: string;
	json?: boolean;
}

/**
 * Format milliseconds as human-readable duration.
 */
function formatDuration(ms: number): string {
	if (ms === 0) return "0s";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainSec = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainSec}s`;
	const hours = Math.floor(minutes / 60);
	const remainMin = minutes % 60;
	return `${hours}h ${remainMin}m`;
}

async function executeMetrics(opts: MetricsOpts): Promise<void> {
	const limit = opts.last ? Number.parseInt(opts.last, 10) : 20;
	const json = opts.json ?? false;

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const dbPath = join(config.project.root, ".overstory", "metrics.db");

	const dbFile = Bun.file(dbPath);
	if (!(await dbFile.exists())) {
		if (json) {
			process.stdout.write('{"sessions":[]}\n');
		} else {
			process.stdout.write("No metrics data yet.\n");
		}
		return;
	}

	const store = createMetricsStore(dbPath);

	try {
		const sessions = store.getRecentSessions(limit);

		if (json) {
			process.stdout.write(`${JSON.stringify({ sessions })}\n`);
			return;
		}

		if (sessions.length === 0) {
			process.stdout.write("No sessions recorded yet.\n");
			return;
		}

		process.stdout.write("📈 Session Metrics\n");
		process.stdout.write(`${"═".repeat(60)}\n\n`);

		// Summary stats
		const completed = sessions.filter((s) => s.completedAt !== null);
		const avgDuration = store.getAverageDuration();

		process.stdout.write(`Total sessions: ${sessions.length}\n`);
		process.stdout.write(`Completed: ${completed.length}\n`);
		process.stdout.write(`Avg duration: ${formatDuration(avgDuration)}\n\n`);

		// Merge tier distribution
		const tierCounts: Record<string, number> = {};
		for (const s of completed) {
			if (s.mergeResult) {
				tierCounts[s.mergeResult] = (tierCounts[s.mergeResult] ?? 0) + 1;
			}
		}
		if (Object.keys(tierCounts).length > 0) {
			process.stdout.write("Merge tiers:\n");
			for (const [tier, count] of Object.entries(tierCounts)) {
				process.stdout.write(`  ${tier}: ${count}\n`);
			}
			process.stdout.write("\n");
		}

		// Capability breakdown
		const capCounts: Record<string, number> = {};
		for (const s of sessions) {
			capCounts[s.capability] = (capCounts[s.capability] ?? 0) + 1;
		}
		process.stdout.write("By capability:\n");
		for (const [cap, count] of Object.entries(capCounts)) {
			const capAvg = store.getAverageDuration(cap);
			process.stdout.write(`  ${cap}: ${count} sessions (avg ${formatDuration(capAvg)})\n`);
		}
		process.stdout.write("\n");

		// Recent sessions table
		process.stdout.write("Recent sessions:\n");
		for (const s of sessions) {
			const status = s.completedAt ? "done" : "running";
			const duration = formatDuration(s.durationMs);
			process.stdout.write(
				`  ${s.agentName} [${s.capability}] ${s.taskId} | ${status} | ${duration}\n`,
			);
		}
	} finally {
		store.close();
	}
}

export function createMetricsCommand(): Command {
	return new Command("metrics")
		.description("Show session metrics")
		.option("--last <n>", "Number of recent sessions to show (default: 20)")
		.option("--json", "Output as JSON")
		.action(async (opts: MetricsOpts) => {
			await executeMetrics(opts);
		});
}

export async function metricsCommand(args: string[]): Promise<void> {
	const cmd = createMetricsCommand();
	cmd.exitOverride();
	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
		}
		throw err;
	}
}
