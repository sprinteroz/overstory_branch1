#!/usr/bin/env bun

/**
 * Overstory CLI — main entry point and command router.
 *
 * Routes subcommands to their respective handlers in src/commands/.
 * Usage: overstory <command> [args...]
 */

import { Command } from "commander";
import { createAgentsCommand } from "./commands/agents.ts";
import { cleanCommand } from "./commands/clean.ts";
import { createCompletionsCommand } from "./commands/completions.ts";
import { createCoordinatorCommand } from "./commands/coordinator.ts";
import { createCostsCommand } from "./commands/costs.ts";
import { createDashboardCommand } from "./commands/dashboard.ts";
import { createDoctorCommand } from "./commands/doctor.ts";
import { createErrorsCommand } from "./commands/errors.ts";
import { createFeedCommand } from "./commands/feed.ts";
import { createGroupCommand } from "./commands/group.ts";
import { createHooksCommand } from "./commands/hooks.ts";
import { initCommand } from "./commands/init.ts";
import { createInspectCommand } from "./commands/inspect.ts";
import { createLogCommand } from "./commands/log.ts";
import { logsCommand } from "./commands/logs.ts";
import { mailCommand } from "./commands/mail.ts";
import { mergeCommand } from "./commands/merge.ts";
import { createMetricsCommand } from "./commands/metrics.ts";
import { createMonitorCommand } from "./commands/monitor.ts";
import { nudgeCommand } from "./commands/nudge.ts";
import { primeCommand } from "./commands/prime.ts";
import { createReplayCommand } from "./commands/replay.ts";
import { createRunCommand } from "./commands/run.ts";
import { slingCommand } from "./commands/sling.ts";
import { specWriteCommand } from "./commands/spec.ts";
import { createStatusCommand } from "./commands/status.ts";
import { stopCommand } from "./commands/stop.ts";
import { createSupervisorCommand } from "./commands/supervisor.ts";
import { traceCommand } from "./commands/trace.ts";
import { createWatchCommand } from "./commands/watch.ts";
import { createWorktreeCommand } from "./commands/worktree.ts";
import { OverstoryError, WorktreeError } from "./errors.ts";
import { setQuiet } from "./logging/color.ts";

const VERSION = "0.6.5";

const COMMANDS = [
	"agents",
	"init",
	"sling",
	"spec",
	"prime",
	"stop",
	"status",
	"dashboard",
	"inspect",
	"clean",
	"doctor",
	"coordinator",
	"supervisor",
	"hooks",
	"monitor",
	"mail",
	"merge",
	"nudge",
	"group",
	"worktree",
	"log",
	"logs",
	"watch",
	"trace",
	"feed",
	"errors",
	"replay",
	"run",
	"costs",
	"metrics",
];

function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	// Use a flat 1D array to avoid nested indexing warnings
	const dp = new Array<number>((m + 1) * (n + 1)).fill(0);
	const idx = (i: number, j: number) => i * (n + 1) + j;
	for (let i = 0; i <= m; i++) dp[idx(i, 0)] = i;
	for (let j = 0; j <= n; j++) dp[idx(0, j)] = j;
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const del = (dp[idx(i - 1, j)] ?? 0) + 1;
			const ins = (dp[idx(i, j - 1)] ?? 0) + 1;
			const sub = (dp[idx(i - 1, j - 1)] ?? 0) + cost;
			dp[idx(i, j)] = Math.min(del, ins, sub);
		}
	}
	return dp[idx(m, n)] ?? 0;
}

function suggestCommand(input: string): string | undefined {
	let bestMatch: string | undefined;
	let bestDist = 3; // Only suggest if distance <= 2
	for (const cmd of COMMANDS) {
		const dist = editDistance(input, cmd);
		if (dist < bestDist) {
			bestDist = dist;
			bestMatch = cmd;
		}
	}
	return bestMatch;
}

const program = new Command();

program
	.name("overstory")
	.description("Multi-agent orchestration for Claude Code")
	.version(`overstory v${VERSION}`, "-v, --version")
	.option("-q, --quiet", "Suppress non-error output")
	.option("--json", "JSON output")
	.option("--verbose", "Verbose output");

// Apply global flags before any command action runs
program.hook("preAction", (thisCmd) => {
	const opts = thisCmd.optsWithGlobals();
	if (opts.quiet) {
		setQuiet(true);
	}
});

// Migrated commands — use addCommand() with createXCommand() factories
program.addCommand(createAgentsCommand());
program.addCommand(createDoctorCommand());
program.addCommand(createCoordinatorCommand());
program.addCommand(createSupervisorCommand());
program.addCommand(createHooksCommand());
program.addCommand(createMonitorCommand());
program.addCommand(createWorktreeCommand());
program.addCommand(createLogCommand());
program.addCommand(createWatchCommand());
program.addCommand(createGroupCommand());
program.addCommand(createCompletionsCommand());

// Unmigrated commands — passthrough pattern
program
	.command("init")
	.description("Initialize .overstory/ in current project")
	.option("--force", "Reinitialize even if .overstory/ already exists")
	.action(async (opts) => {
		await initCommand(opts);
	});

program
	.command("sling")
	.description("Spawn a worker agent")
	.argument("<task-id>", "Task ID to assign")
	.option(
		"--capability <type>",
		"Agent type: builder | scout | reviewer | lead | merger",
		"builder",
	)
	.option("--name <name>", "Unique agent name")
	.option("--spec <path>", "Path to task spec file")
	.option("--files <list>", "Exclusive file scope (comma-separated)")
	.option("--parent <agent>", "Parent agent for hierarchy tracking")
	.option("--depth <n>", "Current hierarchy depth", "0")
	.option("--skip-scout", "Skip scout phase for lead agents")
	.option("--skip-task-check", "Skip task existence validation")
	.option("--force-hierarchy", "Bypass hierarchy validation")
	.option("--json", "Output result as JSON")
	.action(async (taskId, opts) => {
		await slingCommand(taskId, opts);
	});

const specCmd = program.command("spec").description("Manage task specifications");

specCmd
	.command("write")
	.description("Write a spec file to .overstory/specs/<bead-id>.md")
	.argument("<bead-id>", "Task ID for the spec file")
	.option("--body <content>", "Spec content (or pipe via stdin)")
	.option("--agent <name>", "Agent writing the spec (for attribution)")
	.action(async (taskId, opts) => {
		await specWriteCommand(taskId, opts);
	});

program
	.command("prime")
	.description("Load context for orchestrator/agent")
	.option("--agent <name>", "Prime for a specific agent")
	.option("--compact", "Output reduced context (for PreCompact hook)")
	.action(async (opts) => {
		await primeCommand(opts);
	});

program
	.command("stop")
	.description("Terminate a running agent")
	.argument("<agent-name>", "Name of the agent to stop")
	.option("--force", "Force kill and force-delete branch")
	.option("--clean-worktree", "Remove the agent's worktree after stopping")
	.option("--json", "Output as JSON")
	.action(async (agentName, opts) => {
		await stopCommand(agentName, opts);
	});

program.addCommand(createStatusCommand());

program.addCommand(createDashboardCommand());

program.addCommand(createInspectCommand());

program
	.command("clean")
	.description("Wipe runtime state (nuclear cleanup)")
	.option("--all", "Wipe everything (nuclear option)")
	.option("--mail", "Delete mail.db")
	.option("--sessions", "Wipe sessions.db")
	.option("--metrics", "Delete metrics.db")
	.option("--logs", "Remove all agent logs")
	.option("--worktrees", "Remove all worktrees + kill tmux sessions")
	.option("--branches", "Delete all overstory/* branch refs")
	.option("--agents", "Remove agent identity files")
	.option("--specs", "Remove task spec files")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		await cleanCommand(opts);
	});

program
	.command("mail")
	.description("Mail system (send/check/list/read/reply)")
	.allowUnknownOption()
	.allowExcessArguments()
	.action(async (_opts, cmd) => {
		await mailCommand(cmd.args);
	});

program
	.command("merge")
	.description("Merge agent branches into canonical")
	.option("--branch <name>", "Merge a specific branch")
	.option("--all", "Merge all pending branches in the queue")
	.option("--into <branch>", "Target branch to merge into")
	.option("--dry-run", "Check for conflicts without actually merging")
	.option("--json", "Output results as JSON")
	.action(async (opts) => {
		await mergeCommand(opts);
	});

program
	.command("nudge")
	.description("Send a text nudge to an agent")
	.allowUnknownOption()
	.allowExcessArguments()
	.action(async (_opts, cmd) => {
		await nudgeCommand(cmd.args);
	});

program
	.command("logs")
	.description("Query NDJSON logs across agents")
	.allowUnknownOption()
	.allowExcessArguments()
	.action(async (_opts, cmd) => {
		await logsCommand(cmd.args);
	});

program
	.command("trace")
	.description("Chronological event timeline for agent/bead")
	.allowUnknownOption()
	.allowExcessArguments()
	.action(async (_opts, cmd) => {
		await traceCommand(cmd.args);
	});

program.addCommand(createFeedCommand());

program.addCommand(createErrorsCommand());

program.addCommand(createReplayCommand());

program.addCommand(createRunCommand());

program.addCommand(createCostsCommand());

program.addCommand(createMetricsCommand());

// Handle unknown commands with Levenshtein fuzzy-match suggestions
program.on("command:*", (operands) => {
	const unknown = operands[0] ?? "";
	process.stderr.write(`Unknown command: ${unknown}\n`);
	const suggestion = suggestCommand(unknown);
	if (suggestion) {
		process.stderr.write(`Did you mean '${suggestion}'?\n`);
	}
	process.stderr.write("Run 'overstory --help' for usage.\n");
	process.exitCode = 1;
});

async function main(): Promise<void> {
	await program.parseAsync(process.argv);
}

if (import.meta.main)
	main().catch((err: unknown) => {
		// Friendly message when running outside a git repository
		if (err instanceof WorktreeError && err.message.includes("not a git repository")) {
			process.stderr.write("Not in an overstory project. Run 'overstory init' first.\n");
			process.exitCode = 1;
			return;
		}
		if (err instanceof OverstoryError) {
			process.stderr.write(`Error [${err.code}]: ${err.message}\n`);
			process.exitCode = 1;
			return;
		}
		if (err instanceof Error) {
			process.stderr.write(`Error: ${err.message}\n`);
			if (process.argv.includes("--verbose")) {
				process.stderr.write(`${err.stack}\n`);
			}
			process.exitCode = 1;
			return;
		}
		process.stderr.write(`Unknown error: ${String(err)}\n`);
		process.exitCode = 1;
	});
