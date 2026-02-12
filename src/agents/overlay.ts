import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentError } from "../errors.ts";
import type { OverlayConfig } from "../types.ts";

/**
 * Resolve the path to the overlay template file.
 * The template lives at `templates/overlay.md.tmpl` relative to the repo root.
 */
function getTemplatePath(): string {
	// src/agents/overlay.ts -> repo root is ../../
	return join(dirname(import.meta.dir), "..", "templates", "overlay.md.tmpl");
}

/**
 * Format the file scope list as a markdown bullet list.
 * Returns a human-readable fallback if no files are scoped.
 */
function formatFileScope(fileScope: readonly string[]): string {
	if (fileScope.length === 0) {
		return "No file scope restrictions";
	}
	return fileScope.map((f) => `- \`${f}\``).join("\n");
}

/**
 * Format mulch domains as a `mulch prime` command.
 * Returns a human-readable fallback if no domains are configured.
 */
function formatMulchDomains(domains: readonly string[]): string {
	if (domains.length === 0) {
		return "No specific expertise domains configured";
	}
	return `\`\`\`bash\nmulch prime ${domains.join(" ")}\n\`\`\``;
}

/**
 * Format the can-spawn section. If the agent can spawn sub-workers,
 * include an example sling command. Otherwise, state the restriction.
 */
function formatCanSpawn(config: OverlayConfig): string {
	if (!config.canSpawn) {
		return "You may NOT spawn sub-workers.";
	}
	return [
		"You may spawn sub-workers using `overstory sling`. Example:",
		"",
		"```bash",
		"overstory sling <task-id> --capability builder --name <worker-name> \\",
		`  --parent ${config.agentName} --depth ${config.depth + 1}`,
		"```",
	].join("\n");
}

/**
 * Generate a per-worker CLAUDE.md overlay from the template.
 *
 * Reads `templates/overlay.md.tmpl` and replaces all `{{VARIABLE}}`
 * placeholders with values derived from the provided config.
 *
 * @param config - The overlay configuration for this agent/task
 * @returns The rendered overlay content as a string
 * @throws {AgentError} If the template file cannot be found or read
 */
export async function generateOverlay(config: OverlayConfig): Promise<string> {
	const templatePath = getTemplatePath();
	const file = Bun.file(templatePath);
	const exists = await file.exists();

	if (!exists) {
		throw new AgentError(`Overlay template not found: ${templatePath}`, {
			agentName: config.agentName,
		});
	}

	let template: string;
	try {
		template = await file.text();
	} catch (err) {
		throw new AgentError(`Failed to read overlay template: ${templatePath}`, {
			agentName: config.agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}

	const replacements: Record<string, string> = {
		"{{AGENT_NAME}}": config.agentName,
		"{{BEAD_ID}}": config.beadId,
		"{{SPEC_PATH}}": config.specPath ?? "No spec file provided",
		"{{BRANCH_NAME}}": config.branchName,
		"{{PARENT_AGENT}}": config.parentAgent ?? "orchestrator",
		"{{DEPTH}}": String(config.depth),
		"{{FILE_SCOPE}}": formatFileScope(config.fileScope),
		"{{MULCH_DOMAINS}}": formatMulchDomains(config.mulchDomains),
		"{{CAN_SPAWN}}": formatCanSpawn(config),
	};

	let result = template;
	for (const [placeholder, value] of Object.entries(replacements)) {
		// Replace all occurrences — some placeholders appear multiple times
		while (result.includes(placeholder)) {
			result = result.replace(placeholder, value);
		}
	}

	return result;
}

/**
 * Generate the overlay and write it to `{worktreePath}/.claude/CLAUDE.md`.
 * Creates the `.claude/` directory if it does not exist.
 *
 * @param worktreePath - Absolute path to the agent's git worktree
 * @param config - The overlay configuration for this agent/task
 * @throws {AgentError} If the directory cannot be created or the file cannot be written
 */
export async function writeOverlay(worktreePath: string, config: OverlayConfig): Promise<void> {
	const content = await generateOverlay(config);
	const claudeDir = join(worktreePath, ".claude");
	const outputPath = join(claudeDir, "CLAUDE.md");

	try {
		await mkdir(claudeDir, { recursive: true });
	} catch (err) {
		throw new AgentError(`Failed to create .claude/ directory at: ${claudeDir}`, {
			agentName: config.agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}

	try {
		await Bun.write(outputPath, content);
	} catch (err) {
		throw new AgentError(`Failed to write overlay to: ${outputPath}`, {
			agentName: config.agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}
}
