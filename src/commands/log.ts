/**
 * CLI command: overstory log <event> --agent <name>
 *
 * Called by Pre/PostToolUse and Stop hooks.
 * Events: tool-start, tool-end, session-end.
 * Writes to .overstory/logs/{agent-name}/{session-timestamp}/.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createLogger } from "../logging/logger.ts";

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

/**
 * Get or create a session timestamp directory for the agent.
 * Uses a file-based marker to track the current session directory.
 */
async function getSessionDir(logsBase: string, agentName: string): Promise<string> {
	const agentLogsDir = join(logsBase, agentName);
	const markerPath = join(agentLogsDir, ".current-session");

	const markerFile = Bun.file(markerPath);
	if (await markerFile.exists()) {
		const sessionDir = (await markerFile.text()).trim();
		if (sessionDir.length > 0) {
			return sessionDir;
		}
	}

	// Create a new session directory
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const sessionDir = join(agentLogsDir, timestamp);
	const { mkdir } = await import("node:fs/promises");
	await mkdir(sessionDir, { recursive: true });
	await Bun.write(markerPath, sessionDir);
	return sessionDir;
}

/**
 * Entry point for `overstory log <event> --agent <name>`.
 */
export async function logCommand(args: string[]): Promise<void> {
	const event = args.find((a) => !a.startsWith("--"));
	const agentName = getFlag(args, "--agent");

	if (!event) {
		throw new ValidationError("Event is required: overstory log <event> --agent <name>", {
			field: "event",
		});
	}

	const validEvents = ["tool-start", "tool-end", "session-end"];
	if (!validEvents.includes(event)) {
		throw new ValidationError(`Invalid event "${event}". Valid: ${validEvents.join(", ")}`, {
			field: "event",
			value: event,
		});
	}

	if (!agentName) {
		throw new ValidationError("--agent is required for log command", {
			field: "agent",
		});
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const logsBase = join(config.project.root, ".overstory", "logs");
	const sessionDir = await getSessionDir(logsBase, agentName);

	const logger = createLogger({
		logDir: sessionDir,
		agentName,
		verbose: config.logging.verbose,
		redactSecrets: config.logging.redactSecrets,
	});

	switch (event) {
		case "tool-start":
			logger.toolStart("hook-captured", {});
			break;
		case "tool-end":
			logger.toolEnd("hook-captured", 0);
			break;
		case "session-end":
			logger.info("session.end", { agentName });
			// Clear the current session marker
			{
				const markerPath = join(logsBase, agentName, ".current-session");
				try {
					const { unlink } = await import("node:fs/promises");
					await unlink(markerPath);
				} catch {
					// Marker may not exist
				}
			}
			break;
	}

	logger.close();
}
