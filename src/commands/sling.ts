/**
 * CLI command: overstory sling <task-id>
 *
 * CRITICAL PATH. Orchestrates a full agent spawn:
 * 1. Load config + manifest
 * 2. Validate (name unique, depth limit, bead exists)
 * 3. Create worktree
 * 4. Generate + write overlay CLAUDE.md
 * 5. Generate + write hooks config
 * 6. Claim beads issue
 * 7. Create tmux session running claude
 * 8. Record session in sessions.json
 * 9. Return AgentSession
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { deployHooks } from "../agents/hooks-deployer.ts";
import { createIdentity, loadIdentity } from "../agents/identity.ts";
import { createManifestLoader } from "../agents/manifest.ts";
import { writeOverlay } from "../agents/overlay.ts";
import { createBeadsClient } from "../beads/client.ts";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import type { AgentSession, OverlayConfig } from "../types.ts";
import { createWorktree } from "../worktree/manager.ts";
import { createSession } from "../worktree/tmux.ts";

/**
 * Parse a named flag value from an args array.
 */
function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

/**
 * Load the sessions registry from .overstory/sessions.json.
 * Returns an empty array if the file doesn't exist.
 */
async function loadSessions(sessionsPath: string): Promise<AgentSession[]> {
	const file = Bun.file(sessionsPath);
	const exists = await file.exists();
	if (!exists) {
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
 * Save the sessions registry to .overstory/sessions.json.
 */
async function saveSessions(sessionsPath: string, sessions: AgentSession[]): Promise<void> {
	await Bun.write(sessionsPath, JSON.stringify(sessions, null, "\t"));
}

/**
 * Entry point for `overstory sling <task-id> [flags]`.
 *
 * Flags:
 *   --capability <type>    builder | scout | reviewer | lead | merger
 *   --name <name>          Unique agent name
 *   --spec <path>          Path to task spec file
 *   --files <f1,f2,...>    Exclusive file scope
 *   --parent <agent-name>  Parent agent (for hierarchy tracking)
 *   --depth <n>            Current hierarchy depth (default 0)
 */
export async function slingCommand(args: string[]): Promise<void> {
	const taskId = args.find((a) => !a.startsWith("--"));
	if (!taskId) {
		throw new ValidationError("Task ID is required: overstory sling <task-id>", {
			field: "taskId",
		});
	}

	const capability = getFlag(args, "--capability") ?? "builder";
	const name = getFlag(args, "--name");
	const specPath = getFlag(args, "--spec") ?? null;
	const filesRaw = getFlag(args, "--files");
	const parentAgent = getFlag(args, "--parent") ?? null;
	const depthStr = getFlag(args, "--depth");
	const depth = depthStr !== undefined ? Number.parseInt(depthStr, 10) : 0;

	if (!name) {
		throw new ValidationError("--name is required for sling", { field: "name" });
	}

	if (Number.isNaN(depth) || depth < 0) {
		throw new ValidationError("--depth must be a non-negative integer", {
			field: "depth",
			value: depthStr,
		});
	}

	const fileScope = filesRaw ? filesRaw.split(",").map((f) => f.trim()) : [];

	// 1. Load config
	const cwd = process.cwd();
	const config = await loadConfig(cwd);

	// 2. Validate depth limit
	if (depth >= config.agents.maxDepth) {
		throw new AgentError(
			`Depth limit exceeded: depth ${depth} >= maxDepth ${config.agents.maxDepth}`,
			{ agentName: name },
		);
	}

	// 3. Load manifest and validate capability
	const manifestLoader = createManifestLoader(
		join(config.project.root, config.agents.manifestPath),
		join(config.project.root, config.agents.baseDir),
	);
	const manifest = await manifestLoader.load();

	const agentDef = manifest.agents[capability];
	if (!agentDef) {
		throw new AgentError(
			`Unknown capability "${capability}". Available: ${Object.keys(manifest.agents).join(", ")}`,
			{ agentName: name, capability },
		);
	}

	// 4. Check name uniqueness against active sessions
	const sessionsPath = join(config.project.root, ".overstory", "sessions.json");
	const sessions = await loadSessions(sessionsPath);
	const existing = sessions.find((s) => s.agentName === name && s.state !== "zombie");
	if (existing) {
		throw new AgentError(`Agent name "${name}" is already in use (state: ${existing.state})`, {
			agentName: name,
		});
	}

	// 5. Validate bead exists (if beads enabled)
	const beads = createBeadsClient(config.project.root);
	if (config.beads.enabled) {
		try {
			await beads.show(taskId);
		} catch (err) {
			throw new AgentError(`Bead task "${taskId}" not found or inaccessible`, {
				agentName: name,
				cause: err instanceof Error ? err : undefined,
			});
		}
	}

	// 6. Create worktree
	const worktreeBaseDir = join(config.project.root, config.worktrees.baseDir);
	await mkdir(worktreeBaseDir, { recursive: true });

	const { path: worktreePath, branch: branchName } = await createWorktree({
		repoRoot: config.project.root,
		baseDir: worktreeBaseDir,
		agentName: name,
		baseBranch: config.project.canonicalBranch,
		beadId: taskId,
	});

	// 7. Generate + write overlay CLAUDE.md
	const overlayConfig: OverlayConfig = {
		agentName: name,
		beadId: taskId,
		specPath,
		branchName,
		fileScope,
		mulchDomains: config.mulch.enabled ? config.mulch.domains : [],
		parentAgent: parentAgent,
		depth,
		canSpawn: agentDef.canSpawn,
	};

	await writeOverlay(worktreePath, overlayConfig);

	// 8. Deploy hooks config
	await deployHooks(worktreePath, name);

	// 9. Claim beads issue
	if (config.beads.enabled) {
		try {
			await beads.claim(taskId);
		} catch {
			// Non-fatal: issue may already be claimed
		}
	}

	// 10. Create agent identity (if new)
	const identityBaseDir = join(config.project.root, ".overstory", "agents");
	const existingIdentity = await loadIdentity(identityBaseDir, name);
	if (!existingIdentity) {
		await createIdentity(identityBaseDir, {
			name,
			capability,
			created: new Date().toISOString(),
			sessionsCompleted: 0,
			expertiseDomains: config.mulch.enabled ? config.mulch.domains : [],
			recentTasks: [],
		});
	}

	// 11. Create tmux session running claude
	const tmuxSessionName = `overstory-${name}`;
	const claudeCmd = "claude --dangerously-skip-permissions";
	const pid = await createSession(tmuxSessionName, worktreePath, claudeCmd);

	// 12. Record session
	const session: AgentSession = {
		id: `session-${Date.now()}-${name}`,
		agentName: name,
		capability,
		worktreePath,
		branchName,
		beadId: taskId,
		tmuxSession: tmuxSessionName,
		state: "booting",
		pid,
		parentAgent: parentAgent,
		depth,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
	};

	sessions.push(session);
	await saveSessions(sessionsPath, sessions);

	// 13. Output result
	const output = {
		agentName: name,
		capability,
		taskId,
		branch: branchName,
		worktree: worktreePath,
		tmuxSession: tmuxSessionName,
		pid,
	};

	process.stdout.write(`🚀 Agent "${name}" launched!\n`);
	process.stdout.write(`   Task:     ${taskId}\n`);
	process.stdout.write(`   Branch:   ${branchName}\n`);
	process.stdout.write(`   Worktree: ${worktreePath}\n`);
	process.stdout.write(`   Tmux:     ${tmuxSessionName}\n`);
	process.stdout.write(`   PID:      ${pid}\n`);

	if (process.argv.includes("--json")) {
		process.stdout.write(`${JSON.stringify(output)}\n`);
	}
}
