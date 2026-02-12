/**
 * CLI command: overstory watch [--interval <ms>] [--background]
 *
 * Starts the watchdog daemon. Foreground mode shows real-time status.
 * Background mode daemonizes. Interval configurable, default 30000ms.
 */

import { loadConfig } from "../config.ts";
import type { HealthCheck } from "../types.ts";
import { startDaemon } from "../watchdog/daemon.ts";

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
 * Format a health check for display.
 */
function formatCheck(check: HealthCheck): string {
	const actionIcon = check.action === "terminate" ? "💀" : check.action === "escalate" ? "⚠️" : "✅";
	return `${actionIcon} ${check.agentName}: ${check.state} (tmux=${check.tmuxAlive ? "up" : "down"}, pid=${check.processAlive ? "up" : "down"})`;
}

/**
 * Entry point for `overstory watch [--interval <ms>] [--background]`.
 */
export async function watchCommand(args: string[]): Promise<void> {
	const intervalStr = getFlag(args, "--interval");
	const background = hasFlag(args, "--background");

	const cwd = process.cwd();
	const config = await loadConfig(cwd);

	const intervalMs = intervalStr
		? Number.parseInt(intervalStr, 10)
		: config.watchdog.tier1IntervalMs;

	const staleThresholdMs = config.watchdog.staleThresholdMs;
	const zombieThresholdMs = config.watchdog.zombieThresholdMs;

	if (background) {
		// In background mode, start daemon silently and detach
		startDaemon({
			root: config.project.root,
			intervalMs,
			staleThresholdMs,
			zombieThresholdMs,
		});
		process.stdout.write(`👁️  Watchdog started in background (interval: ${intervalMs}ms)\n`);
		return;
	}

	// Foreground mode: show real-time health checks
	process.stdout.write(`👁️  Watchdog running (interval: ${intervalMs}ms)\n`);
	process.stdout.write("Press Ctrl+C to stop.\n\n");

	const { stop } = startDaemon({
		root: config.project.root,
		intervalMs,
		staleThresholdMs,
		zombieThresholdMs,
		onHealthCheck(check) {
			const timestamp = new Date().toISOString().slice(11, 19);
			process.stdout.write(`[${timestamp}] ${formatCheck(check)}\n`);
		},
	});

	// Keep running until interrupted
	process.on("SIGINT", () => {
		stop();
		process.stdout.write("\n👁️  Watchdog stopped.\n");
		process.exit(0);
	});

	// Block forever
	await new Promise(() => {});
}
