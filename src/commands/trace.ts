/**
 * CLI command: overstory trace <target> [--json] [--since <ts>] [--until <ts>] [--limit <n>]
 *
 * Shows a chronological timeline of events for an agent or bead task.
 * Target can be an agent name or a bead ID (resolved to agent name via SessionStore).
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import type { ColorFn } from "../logging/color.ts";
import { color } from "../logging/color.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { EventType, StoredEvent } from "../types.ts";

/** Labels and colors for each event type. */
const EVENT_LABELS: Record<EventType, { label: string; color: ColorFn }> = {
	tool_start: { label: "TOOL START", color: color.blue },
	tool_end: { label: "TOOL END  ", color: color.blue },
	session_start: { label: "SESSION  +", color: color.green },
	session_end: { label: "SESSION  -", color: color.yellow },
	mail_sent: { label: "MAIL SENT ", color: color.cyan },
	mail_received: { label: "MAIL RECV ", color: color.cyan },
	spawn: { label: "SPAWN     ", color: color.magenta },
	error: { label: "ERROR     ", color: color.red },
	custom: { label: "CUSTOM    ", color: color.gray },
};

/**
 * Detect whether a target string looks like a bead ID.
 * Bead IDs follow the pattern: word-alphanumeric (e.g., "overstory-rj1k", "myproject-abc1").
 */
function looksLikeBeadId(target: string): boolean {
	return /^[a-z][a-z0-9]*-[a-z0-9]{3,}$/i.test(target);
}

/**
 * Format a relative time string from a timestamp.
 * Returns strings like "2m ago", "1h ago", "3d ago".
 */
function formatRelativeTime(timestamp: string): string {
	const eventTime = new Date(timestamp).getTime();
	const now = Date.now();
	const diffMs = now - eventTime;

	if (diffMs < 0) return "just now";

	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) return `${seconds}s ago`;

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/**
 * Format an absolute time from an ISO timestamp.
 * Returns "HH:MM:SS" portion.
 */
function formatAbsoluteTime(timestamp: string): string {
	const match = /T(\d{2}:\d{2}:\d{2})/.exec(timestamp);
	if (match?.[1]) {
		return match[1];
	}
	return timestamp;
}

/**
 * Format the date portion of an ISO timestamp.
 * Returns "YYYY-MM-DD".
 */
function formatDate(timestamp: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(timestamp);
	if (match?.[1]) {
		return match[1];
	}
	return "";
}

/**
 * Build a detail string for a timeline event based on its type and fields.
 */
function buildEventDetail(event: StoredEvent): string {
	const parts: string[] = [];

	if (event.toolName) {
		parts.push(`tool=${event.toolName}`);
	}

	if (event.toolDurationMs !== null) {
		parts.push(`duration=${event.toolDurationMs}ms`);
	}

	if (event.data) {
		try {
			const parsed: unknown = JSON.parse(event.data);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const data = parsed as Record<string, unknown>;
				for (const [key, value] of Object.entries(data)) {
					if (value !== null && value !== undefined) {
						const strValue = typeof value === "string" ? value : JSON.stringify(value);
						// Truncate long values
						const truncated = strValue.length > 80 ? `${strValue.slice(0, 77)}...` : strValue;
						parts.push(`${key}=${truncated}`);
					}
				}
			}
		} catch {
			// data is not valid JSON; show it raw if short enough
			if (event.data.length <= 80) {
				parts.push(event.data);
			}
		}
	}

	return parts.join(" ");
}

/**
 * Print events as a formatted timeline with ANSI colors.
 */
function printTimeline(events: StoredEvent[], agentName: string, useAbsoluteTime: boolean): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`${color.bold(`Timeline for ${agentName}`)}\n`);
	w(`${"=".repeat(70)}\n`);

	if (events.length === 0) {
		w(`${color.dim("No events found.")}\n`);
		return;
	}

	w(`${color.dim(`${events.length} event${events.length === 1 ? "" : "s"}`)}\n\n`);

	let lastDate = "";

	for (const event of events) {
		// Print date separator when the date changes
		const date = formatDate(event.createdAt);
		if (date && date !== lastDate) {
			if (lastDate !== "") {
				w("\n");
			}
			w(`${color.dim(`--- ${date} ---`)}\n`);
			lastDate = date;
		}

		const timeStr = useAbsoluteTime
			? formatAbsoluteTime(event.createdAt)
			: formatRelativeTime(event.createdAt);

		const eventInfo = EVENT_LABELS[event.eventType] ?? {
			label: event.eventType.padEnd(10),
			color: color.gray,
		};

		const levelColorFn =
			event.level === "error" ? color.red : event.level === "warn" ? color.yellow : null;
		const applyLevel = (text: string) => (levelColorFn ? levelColorFn(text) : text);

		const detail = buildEventDetail(event);
		const detailSuffix = detail ? ` ${color.dim(detail)}` : "";

		const agentLabel = event.agentName !== agentName ? ` ${color.dim(`[${event.agentName}]`)}` : "";

		w(
			`${color.dim(timeStr.padStart(10))} ` +
				`${applyLevel(eventInfo.color(color.bold(eventInfo.label)))}` +
				`${agentLabel}${detailSuffix}\n`,
		);
	}
}

interface TraceOpts {
	json?: boolean;
	since?: string;
	until?: string;
	limit?: string;
}

async function executeTrace(target: string, opts: TraceOpts): Promise<void> {
	const json = opts.json ?? false;
	const sinceStr = opts.since;
	const untilStr = opts.until;
	const limitStr = opts.limit;
	const limit = limitStr ? Number.parseInt(limitStr, 10) : 100;

	if (Number.isNaN(limit) || limit < 1) {
		throw new ValidationError("--limit must be a positive integer", {
			field: "limit",
			value: limitStr,
		});
	}

	// Validate timestamps if provided
	if (sinceStr !== undefined && Number.isNaN(new Date(sinceStr).getTime())) {
		throw new ValidationError("--since must be a valid ISO 8601 timestamp", {
			field: "since",
			value: sinceStr,
		});
	}
	if (untilStr !== undefined && Number.isNaN(new Date(untilStr).getTime())) {
		throw new ValidationError("--until must be a valid ISO 8601 timestamp", {
			field: "until",
			value: untilStr,
		});
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");

	// Resolve target to agent name
	let agentName = target;

	if (looksLikeBeadId(target)) {
		// Try to resolve bead ID to agent name via SessionStore
		const { store: sessionStore } = openSessionStore(overstoryDir);
		try {
			const allSessions = sessionStore.getAll();
			const matchingSession = allSessions.find((s) => s.beadId === target);
			if (matchingSession) {
				agentName = matchingSession.agentName;
			} else {
				// No session found for this bead ID; treat it as an agent name anyway
				// (the event query will return empty results if no events match)
				agentName = target;
			}
		} finally {
			sessionStore.close();
		}
	}

	// Open event store and query events
	const eventsDbPath = join(overstoryDir, "events.db");
	const eventsFile = Bun.file(eventsDbPath);
	if (!(await eventsFile.exists())) {
		if (json) {
			process.stdout.write("[]\n");
		} else {
			process.stdout.write("No events data yet.\n");
		}
		return;
	}

	const eventStore = createEventStore(eventsDbPath);

	try {
		const events = eventStore.getByAgent(agentName, {
			since: sinceStr,
			until: untilStr,
			limit,
		});

		if (json) {
			process.stdout.write(`${JSON.stringify(events)}\n`);
			return;
		}

		// Use absolute time if --since is specified, relative otherwise
		const useAbsoluteTime = sinceStr !== undefined;
		printTimeline(events, agentName, useAbsoluteTime);
	} finally {
		eventStore.close();
	}
}

export function createTraceCommand(): Command {
	return new Command("trace")
		.description("Chronological event timeline for agent/bead")
		.argument("<target>", "Agent name or bead ID")
		.option("--json", "Output as JSON array of StoredEvent objects")
		.option("--since <timestamp>", "Start time filter (ISO 8601)")
		.option("--until <timestamp>", "End time filter (ISO 8601)")
		.option("--limit <n>", "Max events to show (default: 100)")
		.action(async (target: string, opts: TraceOpts) => {
			await executeTrace(target, opts);
		});
}

export async function traceCommand(args: string[]): Promise<void> {
	const cmd = createTraceCommand();
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
