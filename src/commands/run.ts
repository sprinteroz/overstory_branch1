/**
 * CLI command: overstory run [subcommand] [--json]
 *
 * Manage runs (coordinator session groupings).
 * A "run" groups all agents spawned from one coordinator session.
 *
 * Subcommands:
 *   (default)     Show current run status
 *   list          List recent runs
 *   complete      Mark current run as completed
 *   show <id>     Show run details with agents
 */

import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import type { AgentSession, Run } from "../types.ts";

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

/**
 * Get the path to the current-run.txt file.
 */
function currentRunPath(overstoryDir: string): string {
	return join(overstoryDir, "current-run.txt");
}

/**
 * Read the current run ID from current-run.txt, or null if no active run.
 */
async function readCurrentRunId(overstoryDir: string): Promise<string | null> {
	const path = currentRunPath(overstoryDir);
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return null;
	}
	const text = await file.text();
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Compute duration string for a run.
 */
function runDuration(run: Run): string {
	const start = new Date(run.startedAt).getTime();
	const end = run.completedAt ? new Date(run.completedAt).getTime() : Date.now();
	return formatDuration(end - start);
}

/**
 * Format an agent's duration from startedAt to now (or completion).
 */
function formatAgentDuration(agent: AgentSession): string {
	const start = new Date(agent.startedAt).getTime();
	const end =
		agent.state === "completed" || agent.state === "zombie"
			? new Date(agent.lastActivity).getTime()
			: Date.now();
	return formatDuration(end - start);
}

/**
 * Show current run status (default subcommand).
 */
async function showCurrentRun(overstoryDir: string, json: boolean): Promise<void> {
	const runId = await readCurrentRunId(overstoryDir);
	if (!runId) {
		if (json) {
			process.stdout.write('{"run":null,"message":"No active run"}\n');
		} else {
			process.stdout.write("No active run\n");
		}
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const runStore = createRunStore(dbPath);
	try {
		const run = runStore.getRun(runId);
		if (!run) {
			if (json) {
				process.stdout.write(
					`${JSON.stringify({ run: null, message: `Run ${runId} not found in store` })}\n`,
				);
			} else {
				process.stdout.write(`Run ${runId} not found in store\n`);
			}
			return;
		}

		if (json) {
			process.stdout.write(`${JSON.stringify({ run, duration: runDuration(run) })}\n`);
			return;
		}

		process.stdout.write("Current Run\n");
		process.stdout.write(`${"=".repeat(50)}\n`);
		process.stdout.write(`  ID:       ${run.id}\n`);
		process.stdout.write(`  Status:   ${run.status}\n`);
		process.stdout.write(`  Started:  ${run.startedAt}\n`);
		process.stdout.write(`  Agents:   ${run.agentCount}\n`);
		process.stdout.write(`  Duration: ${runDuration(run)}\n`);
	} finally {
		runStore.close();
	}
}

/**
 * List recent runs.
 */
async function listRuns(overstoryDir: string, limit: number, json: boolean): Promise<void> {
	const dbPath = join(overstoryDir, "sessions.db");
	const dbFile = Bun.file(dbPath);
	if (!(await dbFile.exists())) {
		if (json) {
			process.stdout.write('{"runs":[]}\n');
		} else {
			process.stdout.write("No runs recorded yet.\n");
		}
		return;
	}

	const runStore = createRunStore(dbPath);
	try {
		const runs = runStore.listRuns({ limit });

		if (json) {
			const runsWithDuration = runs.map((r) => ({ ...r, duration: runDuration(r) }));
			process.stdout.write(`${JSON.stringify({ runs: runsWithDuration })}\n`);
			return;
		}

		if (runs.length === 0) {
			process.stdout.write("No runs recorded yet.\n");
			return;
		}

		process.stdout.write("Recent Runs\n");
		process.stdout.write(`${"=".repeat(70)}\n`);
		process.stdout.write(
			`${"ID".padEnd(36)} ${"Status".padEnd(10)} ${"Agents".padEnd(7)} Duration\n`,
		);
		process.stdout.write(`${"-".repeat(70)}\n`);

		for (const run of runs) {
			const id = run.id.length > 35 ? `${run.id.slice(0, 32)}...` : run.id.padEnd(36);
			const status = run.status.padEnd(10);
			const agents = String(run.agentCount).padEnd(7);
			const duration = runDuration(run);
			process.stdout.write(`${id} ${status} ${agents} ${duration}\n`);
		}
	} finally {
		runStore.close();
	}
}

/**
 * Mark the current run as completed.
 */
async function completeCurrentRun(overstoryDir: string, json: boolean): Promise<void> {
	const runId = await readCurrentRunId(overstoryDir);
	if (!runId) {
		if (json) {
			process.stdout.write('{"success":false,"message":"No active run to complete"}\n');
		} else {
			process.stderr.write("No active run to complete\n");
		}
		process.exitCode = 1;
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const runStore = createRunStore(dbPath);
	try {
		runStore.completeRun(runId, "completed");
	} finally {
		runStore.close();
	}

	// Delete current-run.txt
	const { unlink } = await import("node:fs/promises");
	try {
		await unlink(currentRunPath(overstoryDir));
	} catch {
		// File may already be gone, that's fine
	}

	if (json) {
		process.stdout.write(`${JSON.stringify({ success: true, runId, status: "completed" })}\n`);
	} else {
		process.stdout.write(`Run ${runId} marked as completed\n`);
	}
}

/**
 * Show detailed information for a specific run.
 */
async function showRun(overstoryDir: string, runId: string, json: boolean): Promise<void> {
	const dbPath = join(overstoryDir, "sessions.db");
	const dbFile = Bun.file(dbPath);
	if (!(await dbFile.exists())) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ run: null, message: `Run ${runId} not found` })}\n`);
		} else {
			process.stderr.write(`Run ${runId} not found\n`);
		}
		process.exitCode = 1;
		return;
	}

	const runStore = createRunStore(dbPath);
	const sessionStore = createSessionStore(dbPath);
	try {
		const run = runStore.getRun(runId);
		if (!run) {
			if (json) {
				process.stdout.write(
					`${JSON.stringify({ run: null, message: `Run ${runId} not found` })}\n`,
				);
			} else {
				process.stderr.write(`Run ${runId} not found\n`);
			}
			process.exitCode = 1;
			return;
		}

		const agents = sessionStore.getByRun(runId);

		if (json) {
			process.stdout.write(`${JSON.stringify({ run, duration: runDuration(run), agents })}\n`);
			return;
		}

		process.stdout.write("Run Details\n");
		process.stdout.write(`${"=".repeat(60)}\n`);
		process.stdout.write(`  ID:       ${run.id}\n`);
		process.stdout.write(`  Status:   ${run.status}\n`);
		process.stdout.write(`  Started:  ${run.startedAt}\n`);
		if (run.completedAt) {
			process.stdout.write(`  Ended:    ${run.completedAt}\n`);
		}
		process.stdout.write(`  Agents:   ${run.agentCount}\n`);
		process.stdout.write(`  Duration: ${runDuration(run)}\n`);

		if (agents.length > 0) {
			process.stdout.write(`\nAgents (${agents.length}):\n`);
			process.stdout.write(`${"-".repeat(60)}\n`);
			for (const agent of agents) {
				const agentDuration = formatAgentDuration(agent);
				process.stdout.write(
					`  ${agent.agentName} [${agent.capability}] ${agent.state} | ${agentDuration}\n`,
				);
			}
		} else {
			process.stdout.write("\nNo agents recorded for this run.\n");
		}
	} finally {
		runStore.close();
		sessionStore.close();
	}
}

interface RunDefaultOpts {
	json?: boolean;
}

interface RunListOpts {
	last?: string;
	json?: boolean;
}

interface RunShowOpts {
	json?: boolean;
}

interface RunCompleteOpts {
	json?: boolean;
}

export function createRunCommand(): Command {
	const cmd = new Command("run").description("Manage runs (coordinator session groupings)");

	// Default action (bare `overstory run`)
	cmd.option("--json", "Output as JSON").action(async (opts: RunDefaultOpts) => {
		const cwd = process.cwd();
		const config = await loadConfig(cwd);
		const overstoryDir = join(config.project.root, ".overstory");
		await showCurrentRun(overstoryDir, opts.json ?? false);
	});

	// `overstory run list`
	cmd
		.command("list")
		.description("List recent runs")
		.option("--last <n>", "Number of recent runs to show (default: 10)")
		.option("--json", "Output as JSON")
		.action(async (opts: RunListOpts) => {
			const lastStr = opts.last;
			const limit = lastStr ? Number.parseInt(lastStr, 10) : 10;
			if (Number.isNaN(limit) || limit < 1) {
				throw new ValidationError("--last must be a positive integer", {
					field: "last",
					value: lastStr,
				});
			}
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await listRuns(overstoryDir, limit, opts.json ?? false);
		});

	// `overstory run show <id>`
	cmd
		.command("show")
		.description("Show run details (agents, duration)")
		.argument("<id>", "Run ID")
		.option("--json", "Output as JSON")
		.action(async (id: string, opts: RunShowOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await showRun(overstoryDir, id, opts.json ?? false);
		});

	// `overstory run complete`
	cmd
		.command("complete")
		.description("Mark current run as completed")
		.option("--json", "Output as JSON")
		.action(async (opts: RunCompleteOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await completeCurrentRun(overstoryDir, opts.json ?? false);
		});

	return cmd;
}

export async function runCommand(args: string[]): Promise<void> {
	const program = new Command("ov").exitOverride().configureOutput({
		writeOut: (str) => process.stdout.write(str),
		writeErr: (str) => process.stderr.write(str),
	});
	program.addCommand(createRunCommand());
	try {
		await program.parseAsync(["node", "ov", "run", ...args]);
	} catch (err: unknown) {
		if (err instanceof CommanderError) {
			if (err.code === "commander.helpDisplayed" || err.code === "commander.version") return;
			throw new ValidationError(err.message, { field: "args" });
		}
		throw err;
	}
}
