/**
 * CLI command: overstory status [--json] [--watch]
 *
 * Shows active agents, worktree status, beads summary, mail queue depth,
 * and merge queue state. --watch mode uses polling for live updates.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { createMailStore } from "../mail/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import type { AgentSession } from "../types.ts";
import { listWorktrees } from "../worktree/manager.ts";
import { listSessions } from "../worktree/tmux.ts";

/**
 * Parse a named flag value from args.
 */
function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

/**
 * Load sessions.json from .overstory/sessions.json.
 */
async function loadSessions(root: string): Promise<AgentSession[]> {
	const path = join(root, ".overstory", "sessions.json");
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return [];
	}
	try {
		const text = await file.text();
		return JSON.parse(text) as AgentSession[];
	} catch {
		return [];
	}
}

/**
 * Format a duration in ms to a human-readable string.
 */
function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainSec = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainSec}s`;
	const hours = Math.floor(minutes / 60);
	const remainMin = minutes % 60;
	return `${hours}h ${remainMin}m`;
}

interface StatusData {
	agents: AgentSession[];
	worktrees: Array<{ path: string; branch: string; head: string }>;
	tmuxSessions: Array<{ name: string; pid: number }>;
	unreadMailCount: number;
	mergeQueueCount: number;
	recentMetricsCount: number;
}

/**
 * Gather all status data.
 */
async function gatherStatus(root: string): Promise<StatusData> {
	const sessions = await loadSessions(root);

	const worktrees = await listWorktrees(root);

	let tmuxSessions: Array<{ name: string; pid: number }> = [];
	try {
		tmuxSessions = await listSessions();
	} catch {
		// tmux might not be running
	}

	let unreadMailCount = 0;
	try {
		const mailDbPath = join(root, ".overstory", "mail.db");
		const mailFile = Bun.file(mailDbPath);
		if (await mailFile.exists()) {
			const store = createMailStore(mailDbPath);
			const unread = store.getAll({ unread: true });
			unreadMailCount = unread.length;
			store.close();
		}
	} catch {
		// mail db might not exist
	}

	let mergeQueueCount = 0;
	try {
		const queuePath = join(root, ".overstory", "merge-queue.json");
		const queueFile = Bun.file(queuePath);
		if (await queueFile.exists()) {
			const text = await queueFile.text();
			const entries = JSON.parse(text) as Array<{ status: string }>;
			mergeQueueCount = entries.filter((e) => e.status === "pending").length;
		}
	} catch {
		// queue might not exist
	}

	let recentMetricsCount = 0;
	try {
		const metricsDbPath = join(root, ".overstory", "metrics.db");
		const metricsFile = Bun.file(metricsDbPath);
		if (await metricsFile.exists()) {
			const store = createMetricsStore(metricsDbPath);
			recentMetricsCount = store.getRecentSessions(100).length;
			store.close();
		}
	} catch {
		// metrics db might not exist
	}

	return {
		agents: sessions,
		worktrees,
		tmuxSessions,
		unreadMailCount,
		mergeQueueCount,
		recentMetricsCount,
	};
}

/**
 * Print status in human-readable format.
 */
function printStatus(data: StatusData): void {
	const now = Date.now();
	const w = process.stdout.write.bind(process.stdout);

	w("📊 Overstory Status\n");
	w(`${"═".repeat(60)}\n\n`);

	// Active agents
	const active = data.agents.filter((a) => a.state !== "zombie");
	w(`🤖 Agents: ${active.length} active\n`);
	if (active.length > 0) {
		for (const agent of active) {
			const duration = formatDuration(now - new Date(agent.startedAt).getTime());
			const tmuxAlive = data.tmuxSessions.some((s) => s.name === agent.tmuxSession);
			const aliveMarker = tmuxAlive ? "●" : "○";
			w(`   ${aliveMarker} ${agent.agentName} [${agent.capability}] `);
			w(`${agent.state} | ${agent.beadId} | ${duration}\n`);
		}
	} else {
		w("   No active agents\n");
	}
	w("\n");

	// Worktrees
	const overstoryWts = data.worktrees.filter((wt) => wt.branch.startsWith("overstory/"));
	w(`🌳 Worktrees: ${overstoryWts.length}\n`);
	for (const wt of overstoryWts) {
		w(`   ${wt.branch}\n`);
	}
	if (overstoryWts.length === 0) {
		w("   No agent worktrees\n");
	}
	w("\n");

	// Mail
	w(`📬 Mail: ${data.unreadMailCount} unread\n`);

	// Merge queue
	w(`🔀 Merge queue: ${data.mergeQueueCount} pending\n`);

	// Metrics
	w(`📈 Sessions recorded: ${data.recentMetricsCount}\n`);
}

/**
 * Entry point for `overstory status [--json] [--watch]`.
 */
export async function statusCommand(args: string[]): Promise<void> {
	const json = hasFlag(args, "--json");
	const watch = hasFlag(args, "--watch");
	const intervalStr = getFlag(args, "--interval");
	const interval = intervalStr ? Number.parseInt(intervalStr, 10) : 3000;

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;

	if (watch) {
		// Polling loop
		while (true) {
			// Clear screen
			process.stdout.write("\x1b[2J\x1b[H");
			const data = await gatherStatus(root);
			if (json) {
				process.stdout.write(`${JSON.stringify(data, null, "\t")}\n`);
			} else {
				printStatus(data);
			}
			await Bun.sleep(interval);
		}
	} else {
		const data = await gatherStatus(root);
		if (json) {
			process.stdout.write(`${JSON.stringify(data, null, "\t")}\n`);
		} else {
			printStatus(data);
		}
	}
}
