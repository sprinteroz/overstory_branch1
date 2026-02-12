/**
 * CLI command: overstory worktree list | clean [--completed] [--all]
 *
 * List shows worktrees with agent status.
 * Clean removes worktree dirs, branch refs (if merged), and tmux sessions.
 * Logs are never auto-deleted.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import type { AgentSession } from "../types.ts";
import { listWorktrees, removeWorktree } from "../worktree/manager.ts";
import { isSessionAlive, killSession } from "../worktree/tmux.ts";

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
 * Save sessions back to sessions.json.
 */
async function saveSessions(root: string, sessions: AgentSession[]): Promise<void> {
	const path = join(root, ".overstory", "sessions.json");
	await Bun.write(path, JSON.stringify(sessions, null, "\t"));
}

/**
 * Handle `overstory worktree list`.
 */
async function handleList(root: string, json: boolean): Promise<void> {
	const worktrees = await listWorktrees(root);
	const sessions = await loadSessions(root);

	const overstoryWts = worktrees.filter((wt) => wt.branch.startsWith("overstory/"));

	if (json) {
		const entries = overstoryWts.map((wt) => {
			const session = sessions.find((s) => s.worktreePath === wt.path);
			return {
				path: wt.path,
				branch: wt.branch,
				head: wt.head,
				agentName: session?.agentName ?? null,
				state: session?.state ?? null,
				beadId: session?.beadId ?? null,
			};
		});
		process.stdout.write(`${JSON.stringify(entries, null, "\t")}\n`);
		return;
	}

	if (overstoryWts.length === 0) {
		process.stdout.write("No agent worktrees found.\n");
		return;
	}

	process.stdout.write(`🌳 Agent worktrees: ${overstoryWts.length}\n\n`);
	for (const wt of overstoryWts) {
		const session = sessions.find((s) => s.worktreePath === wt.path);
		const state = session?.state ?? "unknown";
		const agent = session?.agentName ?? "?";
		const bead = session?.beadId ?? "?";
		process.stdout.write(`  ${wt.branch}\n`);
		process.stdout.write(`    Agent: ${agent} | State: ${state} | Task: ${bead}\n`);
		process.stdout.write(`    Path: ${wt.path}\n\n`);
	}
}

/**
 * Handle `overstory worktree clean [--completed] [--all]`.
 */
async function handleClean(args: string[], root: string, json: boolean): Promise<void> {
	const all = hasFlag(args, "--all");
	const completedOnly = hasFlag(args, "--completed") || !all;

	const worktrees = await listWorktrees(root);
	const sessions = await loadSessions(root);

	const overstoryWts = worktrees.filter((wt) => wt.branch.startsWith("overstory/"));
	const cleaned: string[] = [];

	for (const wt of overstoryWts) {
		const session = sessions.find((s) => s.worktreePath === wt.path);

		// If --completed (default), only clean worktrees whose agent is done/zombie
		if (completedOnly && session && session.state !== "zombie") {
			continue;
		}

		// If --all, clean everything
		// Kill tmux session if still alive
		if (session?.tmuxSession) {
			const alive = await isSessionAlive(session.tmuxSession);
			if (alive) {
				try {
					await killSession(session.tmuxSession);
				} catch {
					// Best effort
				}
			}
		}

		// Remove worktree
		try {
			await removeWorktree(root, wt.path);
			cleaned.push(wt.branch);

			if (!json) {
				process.stdout.write(`🗑️  Removed: ${wt.branch}\n`);
			}
		} catch (err) {
			if (!json) {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`⚠️  Failed to remove ${wt.branch}: ${msg}\n`);
			}
		}
	}

	// Update sessions.json — mark cleaned sessions as zombie
	const updatedSessions = sessions.map((s) => {
		if (cleaned.some((branch) => s.branchName === branch)) {
			return { ...s, state: "zombie" as const };
		}
		return s;
	});
	await saveSessions(root, updatedSessions);

	if (json) {
		process.stdout.write(`${JSON.stringify({ cleaned })}\n`);
	} else if (cleaned.length === 0) {
		process.stdout.write("No worktrees to clean.\n");
	} else {
		process.stdout.write(
			`\nCleaned ${cleaned.length} worktree${cleaned.length === 1 ? "" : "s"}.\n`,
		);
	}
}

/**
 * Entry point for `overstory worktree <subcommand> [flags]`.
 *
 * Subcommands: list, clean.
 */
export async function worktreeCommand(args: string[]): Promise<void> {
	const subcommand = args[0];
	const subArgs = args.slice(1);
	const jsonFlag = hasFlag(args, "--json");

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;

	switch (subcommand) {
		case "list":
			await handleList(root, jsonFlag);
			break;
		case "clean":
			await handleClean(subArgs, root, jsonFlag);
			break;
		default:
			throw new ValidationError(
				`Unknown worktree subcommand: ${subcommand ?? "(none)"}. Use: list, clean`,
				{ field: "subcommand" },
			);
	}
}
