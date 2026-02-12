import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentError } from "../errors.ts";

/** Read-only capabilities that must never modify files. */
const READ_ONLY_CAPABILITIES = new Set(["scout", "reviewer"]);

/** Tools that read-only agents must not use. */
const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"];

/** Canonical branch names that agents must never push to directly. */
const CANONICAL_BRANCHES = ["main", "master"];

/** Hook entry shape matching Claude Code's settings.local.json format. */
interface HookEntry {
	matcher: string;
	hooks: Array<{ type: string; command: string }>;
}

/**
 * Resolve the path to the hooks template file.
 * The template lives at `templates/hooks.json.tmpl` relative to the repo root.
 */
function getTemplatePath(): string {
	// src/agents/hooks-deployer.ts -> repo root is ../../
	return join(dirname(import.meta.dir), "..", "templates", "hooks.json.tmpl");
}

/**
 * Build a PreToolUse guard that blocks a specific tool.
 *
 * Returns a JSON response with decision=block so Claude Code rejects
 * the tool call before execution.
 */
function blockGuard(toolName: string, reason: string): HookEntry {
	const response = JSON.stringify({ decision: "block", reason });
	return {
		matcher: toolName,
		hooks: [
			{
				type: "command",
				command: `echo '${response}'`,
			},
		],
	};
}

/**
 * Build a Bash guard script that inspects the command from stdin JSON.
 *
 * Claude Code PreToolUse hooks receive `{"tool_input": {"command": "..."}}` on stdin.
 * This builds a bash script that reads stdin, extracts the command, and checks for
 * dangerous patterns (push to canonical branch, hard reset, wrong branch naming).
 */
function buildBashGuardScript(agentName: string): string {
	const canonicalPattern = CANONICAL_BRANCHES.join("|");
	// The script reads JSON from stdin, extracts the command field, then checks patterns.
	// Uses parameter expansion to avoid requiring jq (zero runtime deps).
	const script = [
		"read -r INPUT;",
		// Extract command value from JSON — grab everything after "command":"
		'CMD=$(echo "$INPUT" | sed \'s/.*"command":"\\([^"]*\\)".*/\\1/\');',
		// Check 1: Block git push to canonical branches
		`if echo "$CMD" | grep -qE 'git\\s+push\\s+\\S+\\s+(${canonicalPattern})'; then`,
		`  echo '{"decision":"block","reason":"Agents must not push to canonical branch (${CANONICAL_BRANCHES.join("/")})"}';`,
		"  exit 0;",
		"fi;",
		// Check 2: Block git reset --hard
		"if echo \"$CMD\" | grep -qE 'git\\s+reset\\s+--hard'; then",
		'  echo \'{"decision":"block","reason":"git reset --hard is not allowed — it destroys uncommitted work"}\';',
		"  exit 0;",
		"fi;",
		// Check 3: Warn on git checkout -b with wrong naming convention
		"if echo \"$CMD\" | grep -qE 'git\\s+checkout\\s+-b\\s'; then",
		`  BRANCH=$(echo "$CMD" | sed 's/.*git\\s*checkout\\s*-b\\s*\\([^ ]*\\).*/\\1/');`,
		`  if ! echo "$BRANCH" | grep -qE '^overstory/${agentName}/'; then`,
		`    echo '{"decision":"block","reason":"Branch must follow overstory/${agentName}/{bead-id} convention"}';`,
		"    exit 0;",
		"  fi;",
		"fi;",
	].join(" ");
	return script;
}

/**
 * Generate Bash-level PreToolUse guards for dangerous operations.
 *
 * Applied to ALL agent capabilities. Inspects Bash tool commands for:
 * - `git push` to canonical branches (main/master) — blocked
 * - `git reset --hard` — blocked
 * - `git checkout -b` with non-standard branch naming — blocked
 *
 * @param agentName - The agent name, used for branch naming validation
 */
export function getDangerGuards(agentName: string): HookEntry[] {
	return [
		{
			matcher: "Bash",
			hooks: [
				{
					type: "command",
					command: buildBashGuardScript(agentName),
				},
			],
		},
	];
}

/**
 * Generate capability-specific PreToolUse guards.
 *
 * - scout/reviewer: block Write, Edit, NotebookEdit
 * - builder/lead/merger: no additional capability-specific guards
 *
 * Note: All capabilities also receive Bash danger guards via getDangerGuards().
 */
export function getCapabilityGuards(capability: string): HookEntry[] {
	if (READ_ONLY_CAPABILITIES.has(capability)) {
		return WRITE_TOOLS.map((tool) =>
			blockGuard(tool, `${capability} agents are read-only — ${tool} is not allowed`),
		);
	}
	return [];
}

/**
 * Deploy hooks config to an agent's worktree as `.claude/settings.local.json`.
 *
 * Reads `templates/hooks.json.tmpl`, replaces `{{AGENT_NAME}}`, then merges
 * capability-specific PreToolUse guards into the resulting config.
 *
 * @param worktreePath - Absolute path to the agent's git worktree
 * @param agentName - The unique name of the agent
 * @param capability - Agent capability (builder, scout, reviewer, lead, merger)
 * @throws {AgentError} If the template is not found or the write fails
 */
export async function deployHooks(
	worktreePath: string,
	agentName: string,
	capability = "builder",
): Promise<void> {
	const templatePath = getTemplatePath();
	const file = Bun.file(templatePath);
	const exists = await file.exists();

	if (!exists) {
		throw new AgentError(`Hooks template not found: ${templatePath}`, {
			agentName,
		});
	}

	let template: string;
	try {
		template = await file.text();
	} catch (err) {
		throw new AgentError(`Failed to read hooks template: ${templatePath}`, {
			agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}

	// Replace all occurrences of {{AGENT_NAME}}
	let content = template;
	while (content.includes("{{AGENT_NAME}}")) {
		content = content.replace("{{AGENT_NAME}}", agentName);
	}

	// Parse the base config and merge guards into PreToolUse
	const config = JSON.parse(content) as { hooks: Record<string, HookEntry[]> };
	const dangerGuards = getDangerGuards(agentName);
	const capabilityGuards = getCapabilityGuards(capability);
	const allGuards = [...dangerGuards, ...capabilityGuards];

	if (allGuards.length > 0) {
		const preToolUse = config.hooks.PreToolUse ?? [];
		config.hooks.PreToolUse = [...allGuards, ...preToolUse];
	}

	const finalContent = `${JSON.stringify(config, null, "\t")}\n`;

	const claudeDir = join(worktreePath, ".claude");
	const outputPath = join(claudeDir, "settings.local.json");

	try {
		await mkdir(claudeDir, { recursive: true });
	} catch (err) {
		throw new AgentError(`Failed to create .claude/ directory at: ${claudeDir}`, {
			agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}

	try {
		await Bun.write(outputPath, finalContent);
	} catch (err) {
		throw new AgentError(`Failed to write hooks config to: ${outputPath}`, {
			agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}
}
